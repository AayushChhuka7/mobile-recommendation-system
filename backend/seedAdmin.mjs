// Default admin seed.
//
// Usage:
//   npm run seed:admin
//
// What it does (idempotent — safe to re-run):
//   1. Upserts the `Admin` role row.
//   2. Upserts a default admin user:
//        email:    admin@admin.com
//        password: Admin@12345
//        role:     Admin
//        isVerified: true (skips the OTP flow so the seed admin can
//                    log in immediately)
//
// Environment overrides:
//   SEED_ADMIN_EMAIL    — change the email
//   SEED_ADMIN_PASSWORD — change the password (must satisfy the
//                          `checkPassword` rules in userValidation.mjs:
//                          ≥8 chars, uppercase, lowercase, digit,
//                          special character)
//
// Run only via `npm run seed:admin` — never on app boot.

import "dotenv/config";
import { PrismaClient } from "./src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { hashPassword } from "./src/utils/crypto.mjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const DEFAULT_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@admin.com";
const DEFAULT_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Admin@12345";

async function ensureAdminRole() {
  const role = await prisma.roles.upsert({
    where: { roleName: "Admin" },
    update: {},
    create: { roleName: "Admin" },
  });
  console.log(`role: ${role.roleName} (${role.roleId})`);
  return role;
}

async function ensureDefaultAdmin(adminRoleId) {
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);

  const existing = await prisma.users.findUnique({
    where: { email: DEFAULT_ADMIN_EMAIL },
    select: { userId: true, isActive: true, isVerified: true },
  });

  if (existing) {
    // Promote + verify + reset password so re-running this seed always
    // restores the documented credentials.
    const updated = await prisma.users.update({
      where: { userId: existing.userId },
      data: {
        roleId: adminRoleId,
        password: passwordHash,
        isActive: true,
        isVerified: true,
      },
      select: { userId: true, email: true },
    });
    console.log(
      `admin: updated ${updated.email} (${updated.userId}) — role=Admin, verified=true`,
    );
    return updated;
  }

  const created = await prisma.users.create({
    data: {
      name: "Default Admin",
      email: DEFAULT_ADMIN_EMAIL,
      password: passwordHash,
      isActive: true,
      isVerified: true,
      roleId: adminRoleId,
    },
    select: { userId: true, email: true },
  });
  console.log(
    `admin: created ${created.email} (${created.userId}) — role=Admin, verified=true`,
  );
  return created;
}

async function main() {
  console.log("Default admin seed starting…");

  console.log("Ensuring Admin role");
  const adminRole = await ensureAdminRole();

  console.log(`Ensuring default admin (${DEFAULT_ADMIN_EMAIL})`);
  await ensureDefaultAdmin(adminRole.roleId);

  console.log("Done. Login credentials:");
  console.log(`  email:    ${DEFAULT_ADMIN_EMAIL}`);
  console.log(`  password: ${DEFAULT_ADMIN_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
