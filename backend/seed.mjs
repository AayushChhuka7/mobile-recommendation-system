// RBAC Phase 1 + Phase 2 — idempotent seed.
//
// Usage:
//   npm run seed:rbac
//
// What it does (each step is safe to re-run):
//   Phase 1:
//     1. Upserts the three system roles: Customer, Salesman, Admin.
//     2. Backfills every existing user that has no role by assigning
//        them Customer. Already-assigned users are untouched.
//   Phase 2:
//     3. Upserts the permission keys from the locked matrix.
//     4. Upserts (role, permission) rows per the matrix. Pre-step:
//        deletes rows for a role whose permission is no longer in the
//        matrix, so matrix edits (removals) are picked up on re-run.
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

// ---- Phase 1 ----

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

// ---- Phase 2 ----

// Locked permission key namespace. Format: <resource>:<action>[:<scope>].
// `user:create` was added in this Phase 2 commit to gate admin POST /users;
// it is Admin-only and was not in the original plan matrix.
const SYSTEM_PERMISSIONS = [
  { key: "profile:read:self", description: "Read own profile" },
  { key: "profile:update:self", description: "Update own profile" },
  { key: "user:read", description: "Read any user (admin)" },
  { key: "user:create", description: "Create users (admin)" },
  { key: "user:update", description: "Update any user (admin)" },
  { key: "user:delete", description: "Delete any user (admin)" },
  { key: "role:read", description: "Read roles + role assignments" },
  { key: "role:assign", description: "Assign a role to a user" },
  { key: "role:revoke", description: "Revoke a role from a user" },
];

// Role → permission matrix. Customer / Salesman / Admin keys are
// intersected with SYSTEM_PERMISSIONS to build the join rows. Each
// row is a separate upsert keyed on (roleId, permissionId) so the
// matrix is fully re-runnable.
const ROLE_PERMISSION_MATRIX = {
  Customer: ["profile:read:self", "profile:update:self"],
  Salesman: ["profile:read:self", "profile:update:self"],
  Admin: [
    "profile:read:self",
    "profile:update:self",
    "user:read",
    "user:create",
    "user:update",
    "user:delete",
    "role:read",
    "role:assign",
    "role:revoke",
  ],
};

async function upsertSystemPermissions() {
  for (const { key, description } of SYSTEM_PERMISSIONS) {
    const permission = await prisma.permissions.upsert({
      where: { permissionKey: key },
      update: { description },
      create: { permissionKey: key, description },
    });
    console.log(
      `permission: ${permission.permissionKey} (${permission.permissionId})`,
    );
  }
}

// The join rows use a composite primary key (roleId, permissionId) but
// Prisma's upsert needs a unique where — and the composite isn't a
// named unique constraint. Strategy: look up both ids, then use the
// pair as the where clause. If the row exists we touch nothing; if not
// we create it. Safe to re-run.
async function upsertRolePermissionMatrix() {
  for (const roleName of SYSTEM_ROLES) {
    const role = await prisma.roles.findUnique({ where: { roleName } });
    if (!role) {
      throw new Error(
        `Role "${roleName}" missing — should have been upserted above.`,
      );
    }

    //permission haru ko list/array of that role
    const keysForRole = ROLE_PERMISSION_MATRIX[roleName] || [];

    // Resolve every key for this role to its permissionId up front. If
    // any key is missing from the permissions table, fail loudly —
    // better to crash than to silently produce an incomplete matrix.
    const desiredIds = [];
    for (const permissionKey of keysForRole) {
      const permission = await prisma.permissions.findUnique({
        where: { permissionKey },
      });
      if (!permission) {
        throw new Error(
          `Permission "${permissionKey}" missing — should have been upserted above.`,
        );
      }
      desiredIds.push(permission.permissionId);
    }

    // Reconcile pre-step: delete any (roleId, permissionId) row whose
    // permissionId is no longer in the desired set for this role. This
    // is a no-op when the matrix hasn't changed since the last run.
    // Restricted to the current roleId so it cannot touch other roles.
    const removed = await prisma.rolePermissions.deleteMany({
      where: {
        roleId: role.roleId,
        permissionId: { notIn: desiredIds },
      },
    });

    // Snapshot which (roleId, permissionId) pairs already exist for
    // this role, then upsert the rest. Tracking the "added" count
    // accurately requires a pre-read because Prisma's `upsert` result
    // shape does not distinguish create-vs-update on a composite key.
    const existingRows = await prisma.rolePermissions.findMany({
      where: { roleId: role.roleId },
      select: { permissionId: true },
    });
    const existingIds = existingRows.map((row) => row.permissionId);

    let added = 0;
    for (const permissionId of desiredIds) {
      if (!existingIds.includes(permissionId)) {
        await prisma.rolePermissions.create({
          data: {
            roleId: role.roleId,
            permissionId,
          },
        });
        added += 1;
      }
    }

    console.log(
      `matrix: ${roleName} → ${desiredIds.length} desired, ${added} added, ${removed.count} removed`,
    );
  }
}

async function main() {
  console.log("RBAC seed starting…");

  console.log("Upserting system roles");
  await upsertSystemRoles();

  console.log("Upserting system permissions");
  await upsertSystemPermissions();

  console.log("Upserting role → permission matrix");
  await upsertRolePermissionMatrix();

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
