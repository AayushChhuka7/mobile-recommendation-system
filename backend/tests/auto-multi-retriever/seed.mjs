// Seed helpers for AUTO multi-retriever functional tests A/B/D/F.
//
// Creates a deterministic test fixture: 4 test users (one per test) with
// corresponding phone + BehaviorScore rows. Idempotent on re-run — each
// helper tears down its own rows first.
//
// Usage:
//   node tests/auto-multi-retriever/seed.mjs                 # seed all
//   node tests/auto-multi-retriever/seed.mjs --test=A         # seed only A
//   node tests/auto-multi-retriever/seed.mjs --clean          # tear down all
//
// Mirrors the project's existing pattern of `seed:rbac` /
// `seed:demo-customer` — plain node scripts run against the configured
// DATABASE_URL. No Jest/Vitest setup needed.

import "dotenv/config";
import { prisma } from "../../src/config/prisma.mjs";
import { TEST_IDS } from "./test-ids.mjs";

// Tear down all test rows in dependency order.
async function clean() {
  await prisma.behaviorScore.deleteMany({
    where: { userId: { in: [TEST_IDS.userA, TEST_IDS.userB, TEST_IDS.userD, TEST_IDS.userF] } },
  });
  await prisma.phoneSpecs.deleteMany({
    where: { phoneId: { in: [TEST_IDS.phoneA, TEST_IDS.phoneB, TEST_IDS.phoneF1, TEST_IDS.phoneF2] } },
  });
  await prisma.phoneVariants.deleteMany({
    where: { phoneId: { in: [TEST_IDS.phoneA, TEST_IDS.phoneB, TEST_IDS.phoneF1, TEST_IDS.phoneF2] } },
  });
  await prisma.phones.deleteMany({
    where: { phoneId: { in: [TEST_IDS.phoneA, TEST_IDS.phoneB, TEST_IDS.phoneF1, TEST_IDS.phoneF2] } },
  });
  await prisma.brands.deleteMany({
    where: { brandId: { in: [TEST_IDS.brandA, TEST_IDS.brandB] } },
  });
  await prisma.users.deleteMany({
    where: { userId: { in: [TEST_IDS.userA, TEST_IDS.userB, TEST_IDS.userD, TEST_IDS.userF] } },
  });
  await prisma.roles.deleteMany({
    where: { roleName: "Customer", users: { none: {} } },
  });
}

// Seed base — 4 users, 2 brands, 4 phones.
async function seedBase() {
  // Customer role (idempotent).
  await prisma.roles.upsert({
    where: { roleName: "Customer" },
    update: {},
    create: { roleName: "Customer" },
  });
  const customer = await prisma.roles.findUnique({ where: { roleName: "Customer" } });

  // Users (idempotent — deleteMany first to keep behavior-score rows in sync).
  await prisma.users.deleteMany({
    where: { userId: { in: [TEST_IDS.userA, TEST_IDS.userB, TEST_IDS.userD, TEST_IDS.userF] } },
  });
  const userData = [
    { userId: TEST_IDS.userA, email: "test-a@auto-retriever.local", name: "TestUserA" },
    { userId: TEST_IDS.userB, email: "test-b@auto-retriever.local", name: "TestUserB" },
    { userId: TEST_IDS.userD, email: "test-d@auto-retriever.local", name: "TestUserD" },
    { userId: TEST_IDS.userF, email: "test-f@auto-retriever.local", name: "TestUserF" },
  ];
  for (const u of userData) {
    await prisma.users.create({
      data: {
        userId: u.userId,
        email: u.email,
        password: "test-not-login",
        name: u.name,
        isActive: true,
        isVerified: true,
        roleId: customer.roleId,
      },
    });
  }

  // Brands (idempotent via upsert).
  await prisma.brands.upsert({
    where: { brandId: TEST_IDS.brandA },
    update: { name: "TestBrandA" },
    create: { brandId: TEST_IDS.brandA, name: "TestBrandA" },
  });
  await prisma.brands.upsert({
    where: { brandId: TEST_IDS.brandB },
    update: { name: "TestBrandB" },
    create: { brandId: TEST_IDS.brandB, name: "TestBrandB" },
  });

  // Phones — phoneA passes hard filters (RAM ≥ 4, in_stock),
  //          phoneB violates RAM floor (RAM = 2 → dropped by applyHardFilters).
  //          phoneF1/phoneF2 are for Test F — different brands.
  await prisma.phones.deleteMany({
    where: { phoneId: { in: [TEST_IDS.phoneA, TEST_IDS.phoneB, TEST_IDS.phoneF1, TEST_IDS.phoneF2] } },
  });
  const phoneSpecs = [
    {
      phoneId: TEST_IDS.phoneA,
      brandId: TEST_IDS.brandA,
      modelName: "TestPhone A — Affinity Eligible",
      stockState: "in_stock",
      releasedAt: new Date("2026-01-01"),
      isActive: true,
      ramGb: 8, // for variant
      storageGb: 128,
      price: "499.00",
    },
    {
      phoneId: TEST_IDS.phoneB,
      brandId: TEST_IDS.brandA,
      modelName: "TestPhone B — Affinity but Low RAM",
      stockState: "in_stock",
      releasedAt: new Date("2026-01-01"),
      isActive: true,
      ramGb: 2, // FAILS hard-filter RAM floor of 4
      storageGb: 64,
      price: "199.00",
    },
    {
      phoneId: TEST_IDS.phoneF1,
      brandId: TEST_IDS.brandA,
      modelName: "TestPhone F1 — Brand A",
      stockState: "in_stock",
      releasedAt: new Date("2026-01-01"),
      isActive: true,
      ramGb: 6,
      storageGb: 128,
      price: "399.00",
    },
    {
      phoneId: TEST_IDS.phoneF2,
      brandId: TEST_IDS.brandB,
      modelName: "TestPhone F2 — Brand B",
      stockState: "in_stock",
      releasedAt: new Date("2026-01-01"),
      isActive: true,
      ramGb: 6,
      storageGb: 128,
      price: "399.00",
    },
  ];
  for (const p of phoneSpecs) {
    await prisma.phones.create({
      data: {
        phoneId: p.phoneId,
        brandId: p.brandId,
        modelName: p.modelName,
        stockState: p.stockState,
        releasedAt: p.releasedAt,
        isActive: p.isActive,
      },
    });
    await prisma.phoneVariants.create({
      data: {
        phoneId: p.phoneId,
        ramGb: p.ramGb,
        storageGb: p.storageGb,
        price: p.price,
        isAvailable: true,
      },
    });
    await prisma.phoneSpecs.create({
      data: {
        phoneId: p.phoneId,
        supports5g: false,
        supportsNfc: false,
        dualSim: true,
        batteryMah: 5000,
      },
    });
  }
}

// Per-test behavior-score seeds. Each test user gets a deterministic
// distribution of tags + scores.
async function seedBehaviorScoresA() {
  // Test A: only one active family (affinity). BehaviorScore with high score,
  // recent updatedAt, valid tag.
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userA, tag: `affinity:${TEST_IDS.phoneA}` } },
    update: { score: 8.5, updatedAt: new Date() },
    create: { userId: TEST_IDS.userA, tag: `affinity:${TEST_IDS.phoneA}`, score: 8.5 },
  });
}

async function seedBehaviorScoresB() {
  // Test B: same shape as A but the seeded phone is phoneB (low RAM, fails filter).
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userB, tag: `affinity:${TEST_IDS.phoneB}` } },
    update: { score: 9.0, updatedAt: new Date() },
    create: { userId: TEST_IDS.userB, tag: `affinity:${TEST_IDS.phoneB}`, score: 9.0 },
  });
}

async function seedBehaviorScoresD() {
  // Test D: same fixture as A — re-uses Test A's setup for determinism check.
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userD, tag: `affinity:${TEST_IDS.phoneA}` } },
    update: { score: 8.5, updatedAt: new Date() },
    create: { userId: TEST_IDS.userD, tag: `affinity:${TEST_IDS.phoneA}`, score: 8.5 },
  });
}

async function seedBehaviorScoresF() {
  // Test F: ONLY affinity + brand prefixes (NO model: or tier: rows).
  // affinity: phoneF1 ; brand:TestBrandA ; brand:TestBrandB (both active brand rows).
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userF, tag: `affinity:${TEST_IDS.phoneF1}` } },
    update: { score: 7.0, updatedAt: new Date() },
    create: { userId: TEST_IDS.userF, tag: `affinity:${TEST_IDS.phoneF1}`, score: 7.0 },
  });
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userF, tag: "brand:testbranda" } },
    update: { score: 6.0, updatedAt: new Date() },
    create: { userId: TEST_IDS.userF, tag: "brand:testbranda", score: 6.0 },
  });
  await prisma.behaviorScore.upsert({
    where: { userId_tag: { userId: TEST_IDS.userF, tag: "brand:testbrandb" } },
    update: { score: 5.5, updatedAt: new Date() },
    create: { userId: TEST_IDS.userF, tag: "brand:testbrandb", score: 5.5 },
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cleanFlag = args.includes("--clean");
  const testArg = args.find((a) => a.startsWith("--test="));
  const only = testArg ? testArg.split("=")[1] : null;

  if (cleanFlag) {
    console.log("[clean] tearing down test rows…");
    await clean();
    console.log("[clean] done");
    return;
  }

  console.log("[seed] base rows (users, brands, phones)…");
  await seedBase();

  const seeders = {
    A: seedBehaviorScoresA,
    B: seedBehaviorScoresB,
    D: seedBehaviorScoresD,
    F: seedBehaviorScoresF,
  };

  // Test E reuses Test A's fixture (userA → phoneA) since persona is
  // mocked to fail — we just need any non-empty behavioral candidate.
  if (only === "E") {
    console.log("[seed] behavior scores for test E (reuses Test A fixture)…");
    await seedBehaviorScoresA();
  }

  for (const [letter, fn] of Object.entries(seeders)) {
    if (only && only !== letter) continue;
    console.log(`[seed] behavior scores for test ${letter}…`);
    await fn();
  }

  console.log("[seed] done");
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
