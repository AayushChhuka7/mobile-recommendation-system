-- DropTable
--
-- Reverts RBAC Phase 2. The `permissions` and `role_permissions`
-- tables are no longer referenced by the schema (2026-07-06 revert).
-- Drop `role_permissions` first because of the foreign key on
-- `permissions`. The `session` table is owned by Prisma and is
-- intentionally NOT dropped here.
DROP TABLE "role_permissions";

DROP TABLE "permissions";
