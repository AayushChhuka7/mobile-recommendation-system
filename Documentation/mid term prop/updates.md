# Updates Log

## 2026-06-30 — rbac phase 2 (permissions)

Phase 2 layers fine-grained permissions on top of Phase 1's roles. After this commit, every protected route gates on a permission key (not a role name), and `req.auth` carries the user's permission keys alongside their role names.

### Schema / migrations
- New `permissions` table (`permission_id`, unique `permission_key`, optional `description`).
- New `role_permissions` join — composite PK `(role_id, permission_id)`, both FKs `ON DELETE CASCADE`. New `@@index([permissionId])` for the inverse lookup.
- `Roles` gains the `permissions RolePermissions[]` back-relation. No change to the `users` table itself.
- New `session` model — the `session` table is now owned by Prisma (see "Session-table ownership" below). Migration also creates the table and its `IDX_session_expire` index.
- Migration: `prisma/migrations/20260630131839_add_rbac_phase2/migration.sql`. **One migration, additive, no data loss on existing tables.**

### Service additions (`src/services/rbacService.mjs` — new file)
- `findRoleByName(roleName)`, `findUserRoles(userId)`, `assignRole(userId, roleName)`, `revokeRole(userId)` — moved from `userService.mjs` to `rbacService.mjs`. `userService` no longer imports `prisma.roles` or has any role-related helpers; it owns only the user-row CRUD that has nothing to do with authorization.
- `findUserPermissions(userId)` — new. Returns `string[]` of permission keys for the user's role. One Prisma query: `users → role → role_permissions → permissions`.
- `findRolePermissions(roleId)` — new. Same shape, scoped to one role. Exported for the upcoming admin tooling (stories 2.9 / 2.10) but no current consumer.
- `SAFE_USER_SELECT` re-exported from `rbacService.mjs`. `passport.deserializeUser` continues to use it via the same import path.

### Authorization additions
- `src/middleware/requirePermission.mjs` — new. Variadic, OR-semantics. Reads `req.auth.permissionKeys`. 401 / 403 / pass behavior matches `requireRole` exactly. **This is the only gate new code should reach for.**
- `src/middleware/loadUserRoles.mjs` → renamed to `src/middleware/loadUserContext.mjs`. Same loader, populates **both** `roleNames` and `permissionKeys` on `req.auth`. One query joins through `roleId` to `RolePermissions` → `Permissions`.
- `src/middleware/requireRole.mjs` — header rewritten to make the Phase-1-only status explicit ("zero importers in the codebase; stays in the tree so a future need can reach for it, but new code should not import it"). Behavior unchanged.

### Route changes
- `src/routes/userRoutes.mjs` — full gate swap on all 7 admin routes:
  - `GET /` and `GET /:id` → `requirePermission("user:read")`
  - `POST /` → `requirePermission("user:create")`
  - `PATCH /:id` → `requirePermission("user:update")`
  - `DELETE /:id` → `requirePermission("user:delete")`
  - `POST /:id/roles` → `requirePermission("role:assign")`
  - `DELETE /:id/roles/:roleName` → `requirePermission("role:revoke")`
- The shared `adminOnly = requireRole("Admin")` constant is gone. No `requireRole` import in this file.
- `src/routes/ownUserRoutes.mjs` and `authRoutes.mjs` — `loadUserRoles` → `loadUserContext` on every protected chain. No permission gates added (self-service routes; the loader is wired so `req.auth` is available for any future per-permission check).

### Permission matrix (seeded, idempotent)
| Permission | Customer | Salesman | Admin |
|---|---|---|---|
| `profile:read:self` | ✓ | ✓ | ✓ |
| `profile:update:self` | ✓ | ✓ | ✓ |
| `user:read` |  |  | ✓ |
| `user:create` |  |  | ✓ |
| `user:update` |  |  | ✓ |
| `user:delete` |  |  | ✓ |
| `role:read` |  |  | ✓ |
| `role:assign` |  |  | ✓ |
| `role:revoke` |  |  | ✓ |

The `user:create` row was added in this Phase 2 commit to gate `POST /api/users` (admin creates a user directly). The plan's locked matrix has 8 rows; the seed has 9. The extra row is the documented divergence.

### Seed
- `seed.mjs` extended. Now idempotently upserts 9 permission keys and the (role, permission) join rows per the matrix. Per role, the matrix is reconciled: a `deleteMany` pre-step removes rows whose permission is no longer in the desired set, then a `findMany` snapshot + per-key `create` adds the missing ones. Re-run prints `0 added, 0 removed` for every role when the matrix is unchanged. Matrix edits (additions and removals) are picked up on re-run.
- Run only via `npm run seed:rbac` — never on app boot, never in CI without explicit opt-in.

### Session-table ownership (scope expansion)
The plan did not call this out, but it had to be done for `prisma migrate dev` to work for Phase 2.
- **Before Phase 2:** `connect-pg-simple` was creating the `session` table at runtime via `createTableIfMissing: true` in `src/index.mjs:18`. The migration history had no record of it → "drift detected" on every `migrate dev`.
- **After Phase 2:** `Session` model added to `schema.prisma` (columns match what `connect-pg-simple` was issuing: `sid varchar PK`, `sess json`, `expire timestamp`, plus the `IDX_session_expire` index). `createTableIfMissing` flipped to `false` with a comment explaining the contract. The session table is now Prisma-owned.
- One-time cost: required a `prisma migrate reset` on the local dev DB (every dev's local DB will need this on first pull). After the reset, `prisma migrate status` returns clean and stays clean. No production impact — the migration is additive on any environment that doesn't have a `session` table, and idempotent on one that does (the columns match).

### Conventions enforced
- All permission-aware code reads `req.auth.permissionKeys`, never `req.user`.
- Controllers never import Prisma.
- All role / permission mutations go through `rbacService` (no direct Prisma writes from controllers or middleware).
- `req.auth` is the only auth context for downstream middleware. `req.user` is the minimal session payload.
- All async controllers wrapped in `asyncHandler`.

### Out of scope (per plan)
- Stories 2.8 (dev-only lint guard), 2.9 (`GET /api/admin/permissions`), 2.10 (`POST /api/admin/roles/:roleName/permissions`) — deferred to follow-up commits. See "Known follow-ups" below.

### Known follow-ups (deferred from this commit)
- `requireRole` is dead code as of this commit. Kept in the tree for shape-reuse; flagged in its file header.
- Stories 2.9 / 2.10 — the admin tools for reading permissions and attaching them to roles. New `findRolePermissions` in `rbacService` is ready for these. Plan to ship in a single follow-up commit.
- Story 2.8 — the "no `requireRole` / `requirePermission` after `isAuthenticate`" lint guard. Plan-deferred.
- **Stale session permissions after a role change** — if an admin reassigns a user's role, that user's existing session still carries the old `permissionKeys` until the session is rotated. Same as the Phase 1 "stale session roles" follow-up. Out of scope for both phases.
- **First-Admin bootstrap** — the seed creates role + permission rows only, not a user with `role_id = Admin`. Operators must promote their first Admin with a one-off SQL `UPDATE`. See "Manual steps required" below.

### Manual steps required (per environment)
- After this commit lands, run `npm run seed:rbac` once on every environment. This populates the 9 permission keys and the 9 role→permission rows. Safe to re-run.
- The first Admin in any new environment must be promoted manually:
  ```sql
  UPDATE users SET role_id = (SELECT role_id FROM roles WHERE role_name = 'Admin')
  WHERE email = '<bootstrap-admin-email>';
  ```
  Then log in as that user to pick up the `Admin` permissions on the next session.
- On a previously-existing dev DB, run `prisma migrate reset --force` once before applying this commit's migration, or `prisma migrate resolve` to manually record the migration after applying the SQL by hand. The reset path drops the dev session table; that's fine because `connect-pg-simple` will create it on the next app start (no, wait — `createTableIfMissing` is now `false`; the migration creates it). Either way, the migration's `CREATE TABLE session` line is the authoritative one. After the reset, run `npm run seed:rbac`.

## 2026-06-29 — code-style pass on rbac phase 1

Replaced a few beginner-unfriendly JS idioms in the Phase 1 RBAC code with simpler equivalents. **No behavior change.** Verified end-to-end with a live HTTP test: admin login → assign `Salesman` to a target user → revoke → log in as a `Customer` and confirm they get a 403 on the same endpoint.

- `middleware/requireRole.mjs` — replaced `.some()` with a plain `for` loop (stops at first match via `break`), and replaced the `Array.isArray(...) ? ... : []` ternary with an `if/else`. The loop and the `if/else` produce the same boolean / array that the original one-liners did.
- `services/userService.mjs` — `findUserRoles` no longer uses `user.role?.roleName ? [user.role.roleName] : []`; same `if/else` shape (assign the array when a role exists, otherwise return an empty array).
- `controller/userController.mjs` — `assignUserRole` and `revokeUserRole` no longer use `??` (nullish coalescing) to derive the role label; both use a `let` + `if/else` that sets the label to the role name or `null`.

Allowed JS features kept as-is in this pass: `.includes` and `.filter` (explicitly beginner-friendly per project rule); rest/spread (`...roleNames`, `{ ...data, roleId }`); optional chaining (`?.`) where short-circuiting is the cleanest expression.

No changes to schemas, endpoints, middleware order, or behavior.

## 2026-06-29 — rbac phase 1 (roles only)

### Schema / migrations
- New `roles` table (`role_id`, unique `role_name`) — single source of truth for role names.
- New `role_id` FK on `users` (nullable, `ON DELETE SET NULL`). One role per user at a time. Multi-role is intentionally deferred to Phase 2.
- New `@@index([roleId])` on `users` for fast role lookups.
- Removed the long-commented `roleId` block on `Users` — there is no longer any commented-out role code in `schema.prisma`.
- Migration: `prisma/migrations/20260629121414_add_rbac_phase1/migration.sql`. **One migration, additive, no data loss on the existing tables.**

### Auth changes
- `registerUserService` now looks up the seeded `Customer` role and writes `users.role_id` in the same transaction as `users.create`. Every new user lands as `Customer`. Promotion is admin-only.
- If the seed hasn't been run yet, registration returns a generic 500 ("Service not initialized. Contact support.") — the error message intentionally does not name the missing role or the seed command so the endpoint doesn't leak operational state.

### Authorization additions
- New middleware `middleware/loadUserRoles.mjs` — attaches `req.auth = { userId, isActive, roleNames: string[] }`. Wire order: `isAuthenticate → loadUserRoles → requireRole → controller`.
- New middleware `middleware/requireRole.mjs` — gates a route to users holding at least one of the named roles. **Phase 1 only** — Phase 2 introduces `requirePermission` and `requireRole` is deprecated for new code. A comment in the file flags this.
- `routes/ownUserRoutes.mjs` — `loadUserRoles` added right after `isAuthenticate` so `req.auth` is populated for every self-service endpoint.
- `routes/authRoutes.mjs` — `loadUserRoles` added to the `/me/email/request` and `/me/email/verify` chains.
- `routes/userRoutes.mjs` — was unprotected; now uses `isAuthenticate + loadUserRoles + requireRole("Admin")` at the router level.

### Security
- `passport.deserializeUser` now selects only safe fields (no `password`). `req.user` is the minimal session payload.
- `findUserByEmail` still returns the full row (it needs `password` to verify the local strategy), but the user object handed to passport is a subset, so the password never reaches the session.

### Admin role-assignment endpoints
- `POST /api/users/:id/roles` — body: `{ "roleName": "Customer" | "Salesman" | "Admin" }`. Replaces the user's current role (no append).
- `DELETE /api/users/:id/roles/:roleName` — clears the user's `role_id` (the `roles` row itself is untouched).
- Both endpoints gated by `requireRole("Admin")` — a Phase-1-only compromise; Phase 2 swaps this for `requirePermission("role:assign")`.
- New validation: `assignRoleValidation` in `validation/userValidation.mjs`. `roleName` is whitelisted to the three system roles.

### Service additions (`services/userService.mjs`)
- `findRoleByName(roleName)` — `prisma.roles.findUnique({ where: { roleName } })`.
- `findUserRoles(userId)` — returns `string[]` (one entry today; array shape is forward-compat with Phase 2).
- `assignRole(userId, roleName)` — looks up the role, then `prisma.users.update({ data: { roleId } })`. Throws 404 if the role or user is missing.
- `revokeRole(userId)` — sets `roleId: null`. Throws 404 if the user is missing.

### Seed
- New file `seed.mjs`. Wired to `npm run seed:rbac` in `package.json`.
- Idempotent: `upsert` the three system roles, then a single `updateMany` that backfills any user with `role_id IS NULL` to `Customer`. Already-assigned users are untouched. Safe to re-run.
- Never runs on app boot, never runs in CI without explicit opt-in.

### Conventions enforced
- All role mutations go through the service layer (no direct Prisma writes from controllers or middleware).
- Controllers never import Prisma.
- Services never touch `req`/`res`/`next` except where session/cookie cleanup is unavoidable.
- All async controllers wrapped in `asyncHandler`.
- `req.auth` is the only auth context for downstream middleware. `req.user` is the minimal session payload.

### Out of scope (per plan)
- No permissions table, no `requirePermission` middleware.
- No UI for role assignment — admin endpoints only (manual via API/Postman).
- No role hierarchy / inheritance.
- No audit log on role mutations.
- No "soft-delete role" or "deactivate role".
- No `requireRole` usage outside the admin user-management routes and the role-assignment endpoints themselves.

### Known follow-ups (deferred)
- `requireRole` is fine for Phase 1 but is exactly the pattern we want to stop using in Phase 2. **Use `requirePermission` for any new code.**
- `requireRole("Admin")` on the role-assignment endpoints is a Phase-1-only compromise. Phase 2 replaces with `requirePermission("role:assign")`.
- Stale-session-role: if an admin reassigns a user's role, that user's existing session still carries the old `roleNames` until the session is rotated. Out of scope for Phase 1.
- `req.user.roleId` is now an extra field on the safe select. If Phase 2 introduces richer auth context, this gets folded into `req.auth`.

### Open
- (unchanged from 2026-06-28) `findActiveUserById` exists in `userService` but passport strategy still uses `prisma.users.findUnique` directly in `deserializeUser`, so a deactivated user still has a live session until the cookie expires. Wire `findActiveUserById` into the strategy.
- (unchanged) `validOtpId` lives in the session. Session rotation between `/forget/verify` and `/forget/changePassword` produces a 400.
- (unchanged) `.env.example` still missing — recreate before onboarding a new dev.
- (unchanged) `/api/products` is a stub.
- (unchanged) `console.log(process.env.DATABASE_URL)` is gone from `config/prisma.mjs` (left as a commented line only).

## 2026-06-28 — otp purpose

### Schema / migrations
- New `OtpPurpose` enum on the `Otp` model: `Registration | PasswordReset | EmailChange` (default `Registration`).
- Added composite index `@@index([userId, purpose, isUsed, expiresAt])` on `Otp` to make "latest valid OTP for this user + purpose" a single index lookup.
- Old migration folders (`20260610102633_few`, `20260615024256_addig`) were removed and replaced by a single `20260628051029_initial/migration.sql`. **This is destructive** — anyone with a previously-migrated DB needs to drop & re-apply, or write a hand-rolled migration that adds the enum + index without dropping the tables.

### Auth module additions (consolidated onto existing routes)
- `POST /api/auth/me/email/request` — change-email start (authenticated): requires current password + new email; sends OTP to the **new** email; stores the pending email in `req.session.pendingEmail`.
- `POST /api/auth/me/email/verify` — verifies OTP against `req.user.userId` (purpose `EmailChange`) and swaps `users.email` to `pendingEmail`.
- New `services/authService.mjs` exports: `requestEmailChangeService`, `verifyEmailChangeService`, `changePasswordWhileLoggedInService`, `findOtpById`.
- New `middleware/verifyOwnOtp.mjs` — authenticated OTP verifier; requires `req.session.pendingEmail` and a valid `EmailChange` OTP.

### Self-service profile module (wired through)
- `GET /api/users/me` — view own profile (pulls from `req.user` set by passport).
- `PATCH /api/users/me` — update own name / phone; reuses `updateUser` from `userService`.
- `PATCH /api/users/me/password` — change password while logged in (`changePasswordWhileLoggedInService` checks current password, hashes new one via `validationWith`).
- `POST /api/users/me/deactivate` — soft-delete (`isActive=false`), then `req.logout` + `req.session.destroy` + clear `connect.sid` cookie.
- New `routes/ownUserRoutes.mjs`, mounted under `/users` (after `userRoutes`) so `/me` literal wins over `/:id`. All routes gated by `isAuthenticate` at the router level.
- New `services/userService.mjs` exports: `findActiveUserById`, `deactivateOwnAccount`.

### Forget-password flow tightened
- `POST /api/auth/forget/verify` — now just `verifyOtp + ackOtpVerified` (returns a small ack so the FE can show the change-password form).
- `POST /api/auth/forget/changePassword` — now requires the `isOtpVerified` gate (`req.session.validOtpId` + DB re-check of `expiresAt`/`isUsed`) before allowing the password swap. The two-step window is now bounded.

### Validator tightening
- `validationWith(schemas, allowedFields?)` accepts an optional field whitelist. Every route that takes a body now passes an explicit allowlist (e.g. `["name", "email", "password", "confirmPassword", "phoneNo"]`) so extra keys fail with 400 instead of being silently dropped by `matchedData`.
- Still auto-hashes `req.data.password` when present.

### Conventions enforced
- Controllers never import Prisma — they only call services.
- Services never touch `req`/`res`/`next` except where a tiny amount of session/cookie cleanup is unavoidable (e.g. `userLogoutService`, `deactivateOwnAccount` controller).
- Validation schemas are pure — no DB calls, no hashing. (`userValidation.mjs` still does an existence check inside `custom` for email/phone uniqueness; that's the only DB-touching validation and it's the established pattern from before this commit.)
- All async controllers wrapped in `asyncHandler`.
- Routes wire middleware + controllers only; no inline business logic.

### Open / known gaps
- Admin role / route protection for `routes/userRoutes.mjs` (still unprotected — any logged-in user can hit `/users`, `/users/:id`, PATCH/DELETE).
- `findActiveUserById` exists in `userService` but passport strategy still uses `prisma.users.findUnique` directly in `deserializeUser`, so a deactivated user still has a live session until the cookie expires. Wire `findActiveUserById` into the strategy.
- `validOtpId` lives in the session. If the session is rotated between `/forget/verify` and `/forget/changePassword`, the user gets a 400 — currently acceptable, but document the contract for the FE.
- `.env.example` was deleted in the prior `chore(security)` commit and not re-added. Recreate it before onboarding a new dev.
- `/api/products` is a stub (`"Product page"`) and the entire router sits behind `isAuthenticate` — fine for now, but remove the gate when the module lands.
- `console.log(process.env.DATABASE_URL)` is still in `src/config/prisma.mjs` from before the security commit — leftover from the redacted-DB-log work. Strip it.

## 2026-06-27

### Restructure
- Split mixed concerns in `src/`. Routes now wire only; controllers are thin; services own logic + Prisma.
- New folders: `utils/` (crypto, email), `services/` (replaces single `service/` file), `strategies/` (typo fix from `stratagies/`).
- Removed: `middleware/authOtp.mjs`, `middleware/emailSend.mjs`, `middleware/userMiddleware.mjs`, `config/index.mjs`.
- `validationWith` middleware now lives at `middleware/validator.mjs`.

### Auth module additions
- `POST /api/auth/me/email/request` — change-email start: requires current password + new email; sends OTP to new email; stores pending email in session.
- `POST /api/auth/me/email/verify` — verifies OTP (authenticated) and swaps the user's email.
- `POST /api/auth/forget/verify` — new two-step split: verify OTP only (returns ack so frontend can show the change-password form).
- `POST /api/auth/forget/changePassword` — now requires `isOtpVerified` gate instead of inline `verifyOtp`.

### Self-service profile module
- `GET /api/users/me` — view own profile.
- `PATCH /api/users/me` — update own name / phone.
- `PATCH /api/users/me/password` — change password while logged in (requires current password).
- `POST /api/users/me/deactivate` — soft-delete (sets `isActive=false`), destroys session, clears cookie.
- New router file `routes/ownUserRoutes.mjs` mounted under `/users` (after `userRoutes`, so `/me` literal wins over `/:id`).

### New middleware
- `middleware/verifyOwnOtp.mjs` — authenticated OTP verification (uses `req.user.userId`).
- `middleware/isOtpVerified.mjs` — gate that re-checks the OTP row in DB (`expiresAt` + `isUsed`) before allowing the next step. Clears the session flag on stale/used OTP.

### New validation schemas
- `updateOwnProfileValidation`, `changePasswordWhileLoggedInValidation`, `requestEmailChangeValidation` (in `validation/userValidation.mjs`).

### Service additions
- `services/userService.mjs`: `deactivateOwnAccount`, `findActiveUserById`.
- `services/authService.mjs`: `findOtpById`, `changePasswordWhileLoggedInService`, `requestEmailChangeService`, `verifyEmailChangeService`.

### Conventions enforced
- Controllers never import Prisma.
- Services never touch `req`/`res`/`next`.
- Middleware may read `req`/`res` and call services.
- Validation schemas are pure; no DB calls, no hashing.
- All async controllers wrapped in `asyncHandler`.

### Open
- Admin role / route protection for `routes/userRoutes.mjs` (currently unprotected).
- `findActiveUserById` exists but is not yet wired into the passport strategy.
- Recommendation Module, Region Module not started.