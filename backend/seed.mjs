// RBAC Phase 1 — idempotent seed.
//
// Usage:
//   npm run seed:rbac
//
// What it does (each step is safe to re-run):
//   1. Upserts the three system roles: Customer, Salesman, Admin.
//   2. Backfills every existing user that has no role by assigning
//      them Customer. Already-assigned users are untouched.
//
// No CLI args. No audit log (Phase 1 explicitly excludes it).
//
// Run only via `npm run seed:rbac` — never on app boot.

import "dotenv/config";
import { PrismaClient } from "./src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const SYSTEM_ROLES = ["Customer", "Salesman", "Admin"];

async function upsertSystemRoles() {
  for (const roleName of SYSTEM_ROLES) {
    const role = await prisma.roles.upsert({
      where: { roleName },
      update: {},
      create: { roleName },
    });
    console.log(`role: ${role.roleName} (${role.roleId})`);
  }
}

async function backfillCustomer() {
  const customer = await prisma.roles.findUnique({
    where: { roleName: "Customer" },
  });
  if (!customer) {
    throw new Error("Customer role missing — should have been upserted above.");
  }

  const usersWithoutRole = await prisma.users.findMany({
    where: { roleId: null },
    select: { userId: true, email: true },
  });

  if (usersWithoutRole.length === 0) {
    console.log("backfill: no users without a role");
    return;
  }

  // Single bulk update. Safe to re-run: once a user has roleId set,
  // the WHERE clause won't match them.
  const result = await prisma.users.updateMany({
    where: { roleId: null },
    data: { roleId: customer.roleId },
  });

  console.log(`backfill: ${result.count} user(s) → Customer`);
  for (const u of usersWithoutRole) {
    console.log(` - ${u.email} (${u.userId})`);
  }
}

async function main() {
  console.log("RBAC Phase 1 seed starting…");
  console.log("• Upserting system roles");
  await upsertSystemRoles();

  console.log("Backfilling users without a role → Customer");
  await backfillCustomer();

  console.log("Done");
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
