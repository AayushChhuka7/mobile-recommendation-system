// Demo customer seed.
//
// Usage:
//   npm run seed:demo-customer
//
// What it does (each step is safe to re-run, idempotent):
//   1. Ensures the `Customer` role exists (no-op if `seed:rbac` already ran).
//   2. Ensures a verified demo user:
//        email:    demo@mobilereco.local
//        password: Demo@12345
//        role:     Customer
//        isActive: true, isVerified: true  → can log in immediately,
//        no OTP flow required.
//   3. Ensures a matching UserProfile, UserPreference, and CustomerProfile
//      so the recommend pipeline has a realistic customer record to work
//      against on first login.
//   4. Ensures 10 realistic `recommendation_logs` impressions against the
//      phone catalog, each with a non-null `requestId` (UUID) so the
//      `impression_unique_idx` UNIQUE constraint on
//      (user_id, phone_id, source, COALESCE(request_id, '00000000-…'))
//      is never violated. The request IDs are deterministic per phone
//      (hash of phoneId) so re-running this seed is a true upsert and
//      never produces duplicate-key errors.
//
// Why this exists:
//   The CSV importer (`importCustomers.mjs`) creates users with
//   `isVerified: false`, so they're not usable for a login demo. This
//   script is the verified counterpart, kept separate so the CSV import
//   flow stays untouched.
//
// Environment overrides (optional):
//   DEMO_CUSTOMER_EMAIL    — change the email
//   DEMO_CUSTOMER_PASSWORD — change the password
//
// Run only via `npm run seed:demo-customer` — never on app boot.

import "dotenv/config";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../../src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { hashPassword } from "../../../src/utils/crypto.mjs";

const DEMO_EMAIL = process.env.DEMO_CUSTOMER_EMAIL || "demo@mobilereco.local";
const DEMO_PASSWORD = process.env.DEMO_CUSTOMER_PASSWORD || "Demo@12345";
const DEMO_NAME = "Demo Customer";

// Number of seed impressions to write into recommendation_logs.
const DEMO_LOG_COUNT = 10;

// Stable, deterministic UUIDv5-like identifier derived from a phoneId
// so re-running this seed re-upserts the same `requestId` and never
// creates duplicate impression rows.
//
// We hash the phoneId with SHA-256 and take the first 16 bytes, then
// patch the UUID v4 layout. This is NOT a real UUID v5 — it's only
// used as a stable, deterministic 128-bit token for `requestId` so
// the UNIQUE constraint's COALESCE bucket is never ambiguous.
function deterministicRequestId(phoneId, source) {
  const hex = createHash("sha256")
    .update(`demo::${phoneId}::${source}`)
    .digest("hex");
  const bytes = hex.slice(0, 32);
  return [
    bytes.slice(0, 8),
    bytes.slice(8, 12),
    // Force version-4 layout bits per RFC 4122 (purely cosmetic — the
    // DB column is uuid and accepts any 16-byte hex sequence).
    "4" + bytes.slice(13, 16),
    ((parseInt(bytes.slice(16, 17), 16) & 0x3) | 0x8).toString(16) +
      bytes.slice(17, 20),
    bytes.slice(20, 32),
  ].join("-");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function ensureCustomerRole() {
  const role = await prisma.roles.upsert({
    where: { roleName: "Customer" },
    update: {},
    create: { roleName: "Customer" },
  });
  console.log(`role: ${role.roleName} (${role.roleId})`);
  return role;
}

async function ensureDemoUser(customerRoleId) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const existing = await prisma.users.findUnique({
    where: { email: DEMO_EMAIL },
    select: { userId: true },
  });

  if (existing) {
    // Re-running the seed must always restore the documented credentials
    // and the verified state, otherwise the demo silently breaks after
    // the first CSV import resets something.
    const updated = await prisma.users.update({
      where: { userId: existing.userId },
      data: {
        name: DEMO_NAME,
        password: passwordHash,
        roleId: customerRoleId,
        isActive: true,
        isVerified: true,
      },
      select: { userId: true, email: true },
    });
    console.log(
      `demo: updated ${updated.email} (${updated.userId}) — role=Customer, verified=true`,
    );
    return updated;
  }

  const created = await prisma.users.create({
    data: {
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      password: passwordHash,
      isActive: true,
      isVerified: true,
      roleId: customerRoleId,
    },
    select: { userId: true, email: true },
  });
  console.log(
    `demo: created ${created.email} (${created.userId}) — role=Customer, verified=true`,
  );
  return created;
}

async function ensureProfile(userId) {
  await prisma.userProfile.upsert({
    where: { userId },
    update: {
      age: 28,
      gender: "Other",
      city: "Kathmandu",
      country: "Nepal",
    },
    create: {
      userId,
      age: 28,
      gender: "Other",
      city: "Kathmandu",
      country: "Nepal",
    },
  });
}

async function ensurePreference(userId) {
  // UserPreference.maxBudget is Decimal(10, 2) — Prisma accepts a
  // number; the adapter serializes to the PG numeric type.
  await prisma.userPreference.upsert({
    where: { userId },
    update: {
      maxBudget: 40000,
      cameraPreference: "Sensible",
      usageType: "Casual",
      preferredBrands: ["Samsung", "Xiaomi"],
    },
    create: {
      userId,
      maxBudget: 40000,
      cameraPreference: "Sensible",
      usageType: "Casual",
      preferredBrands: ["Samsung", "Xiaomi"],
    },
  });
}

async function ensureCustomerProfile(userId) {
  // `budgetSegment` is a Prisma enum; pass the enum member name, not the
  // human-readable label. The user's maxBudget of 40000 fits "MidRangeBuyer".
  await prisma.customerProfile.upsert({
    where: { userId },
    update: {
      budgetSegment: "MidRangeBuyer",
      recommendationPersona: "demo",
      segmentConfidence: "provisional",
      avgBudget: 40000,
    },
    create: {
      userId,
      budgetSegment: "MidRangeBuyer",
      recommendationPersona: "demo",
      segmentConfidence: "provisional",
      avgBudget: 40000,
    },
  });
}

async function ensureRecommendationHistory(userId) {
  // Pull the first N phones in deterministic order so the seed is
  // reproducible across machines.
  const phones = await prisma.phones.findMany({
    where: { isActive: true },
    orderBy: { phoneId: "asc" },
    take: DEMO_LOG_COUNT,
    select: { phoneId: true, modelName: true },
  });

  if (phones.length === 0) {
    console.warn(
      "demo: no phones in catalog — skipping recommendation_logs seed. Run `npm run seed:phones` first.",
    );
    return 0;
  }

  const source = "auto";

  // The (user_id, phone_id, source, request_id) UNIQUE constraint on
  // recommendation_logs is declared as a COALESCE-expression index in
  // the v2 migration (`impression_unique_idx`), which Postgres cannot
  // use as the target of `INSERT … ON CONFLICT`. Therefore Prisma's
  // `upsert` (which compiles to ON CONFLICT under the PG driver
  // adapter) cannot resolve `where: { impression_unique: { … } }`.
  //
  // Idempotency strategy:
  //   1. Delete the demo user's prior rows that were seeded by THIS
  //      script (keyed by their deterministic requestId). The
  //      deleteMany is safe to re-run.
  //   2. createMany the fresh rows with skipDuplicates: true, which
  //      silently no-ops on any concurrent inserts that match.
  //
  // Deterministic requestId per (phoneId, source) means rows that
  // pre-exist from a prior run are exactly the ones we just deleted,
  // so this never leaks duplicates and never produces unique-key
  // violations on a single-process run.
  const requestIds = phones.map((p) => deterministicRequestId(p.phoneId, source));

  await prisma.recommendationLog.deleteMany({
    where: {
      userId,
      source,
      requestId: { in: requestIds },
    },
  });

  const now = new Date();
  const rows = phones.map((phone, i) => {
    const rank = i + 1;
    const finalScore = Number((0.95 - i * 0.04).toFixed(2));
    const clicked = i < 4;
    const skipped = i >= 4;
    const dwellMs = clicked ? 4200 : 1800;
    return {
      userId,
      phoneId: phone.phoneId,
      finalScore,
      rank,
      source,
      requestId: requestIds[i],
      dwellMs,
      clicked,
      skipped,
      isTrainingEligible: true,
      firstSeenAt: now,
      shownAt: now,
    };
  });

  const result = await prisma.recommendationLog.createMany({
    data: rows,
    skipDuplicates: true,
  });

  console.log(
    `demo: wrote ${result.count} recommendation_logs row(s) for ${phones.length} phone(s)`,
  );
  return result.count;
}

async function main() {
  console.log("Demo customer seed starting…");

  console.log("Ensuring Customer role");
  const customerRole = await ensureCustomerRole();

  console.log(`Ensuring demo customer (${DEMO_EMAIL})`);
  const demo = await ensureDemoUser(customerRole.roleId);

  console.log("Ensuring UserProfile");
  await ensureProfile(demo.userId);

  console.log("Ensuring UserPreference");
  await ensurePreference(demo.userId);

  console.log("Ensuring CustomerProfile");
  await ensureCustomerProfile(demo.userId);

  console.log("Seeding recommendation_logs");
  await ensureRecommendationHistory(demo.userId);

  console.log("Done. Login credentials:");
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error("Demo customer seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
