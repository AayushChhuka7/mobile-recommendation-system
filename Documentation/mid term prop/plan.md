# Plan — RBAC Rollout (Phased)

This plan covers **only** Role-Based Access Control. Product, mobile, region, and business-domain tables are **out of scope** and intentionally deferred.

The work is split into two phases. Phase 1 ships a usable role system (assign/revoke, defaults, role-aware middleware). Phase 2 layers fine-grained permissions on top without breaking Phase 1.

---

## Phase Overview

| Phase | Scope | Goal | Breaks nothing? |
|---|---|---|---|
| **Phase 1** | Roles only — `Roles` + `UserRoles` | Any user can hold zero-or-more roles; routes can ask "do you have role X?" | Yes — additive schema + middleware |
| **Phase 2** | Permissions — `Permissions` + `RolePermissions` | Routes ask "do you have permission key Y?"; roles become permission bundles | Yes — `requirePermission` is additive on top of `requireRole` |

After Phase 2, the codebase should never grow new `if (user.role === ...)` branches in controllers/services. All future gates go through `requirePermission`.

---

## Phase 1 — Roles Only

### Scope

- New table: `roles` (single source of truth for role names)
- New `role_id` FK on `users` (nullable, `ON DELETE SET NULL`); **one role per user, permanently**
- Remove the commented `roleId` block on `Users`
- Seed three system roles: `Customer`, `Salesman`, `Admin`
- New middleware: `requireRole(...roleNames)`
- New session loader: `loadUserRoles` (attaches `req.auth = { userId, isActive, roleNames }`)
- New service functions in `userService`: `findRoleByName`, `findUserRoles`, `assignRole`, `revokeRole`
- Backfill: every existing user with `role_id IS NULL` is set to `Customer`
- `req.user` cleanup: stop leaking the full row (including `password`) into the session — `passport.deserializeUser` selects only safe fields
- Admin-only endpoints: `POST /api/users/:id/roles` (assign), `DELETE /api/users/:id/roles/:roleName` (revoke)

### Out of scope for Phase 1

- No permissions table, no `requirePermission` middleware
- No UI for role assignment (admin endpoint only — manual via API/Postman until admin module lands)
- No role hierarchy / inheritance
- No audit log
- No "soft-delete role" or "deactivate role"
- **No multi-role per user. Ever.** A user always has zero or one role. The `role_id` FK is the only storage; no `user_roles` table is planned or will be added later.

### Stories (priority order)

| # | Story | Priority | Notes |
|---|---|---|---|
| 1.1 | Schema: add `Roles`, add `role_id` FK on `Users` | **P0 — blocker** | Must run first; everything else depends on it |
| 1.2 | Migration: `npx prisma migrate dev --name add_rbac_phase1` | **P0 — blocker** | One migration file |
| 1.3 | Seed script: 3 system roles + backfill existing users to `Customer` | **P0 — blocker** | Idempotent (`upsert`); runs once via `npm run seed:rbac` |
| 1.4 | `userService`: `findRoleByName`, `findUserRoles`, `assignRole`, `revokeRole` | P0 | Pure Prisma access |
| 1.5 | Middleware: `requireRole(...roleNames)` | P0 | Single-purpose gate; checks `req.auth.roleNames` |
| 1.6 | Session loader: `loadUserRoles` | P0 | Attaches `{ userId, isActive, roleNames: string[] }` to `req.auth` |
| 1.7 | Wire `isAuthenticate → loadUserRoles` on all protected routers | P0 | `ownUserRoutes`, the `/auth/me/*` routes, admin `userRoutes` |
| 1.8 | Admin-only endpoints: `POST /api/users/:id/roles`, `DELETE /api/users/:id/roles/:roleName` | P0 | Gated by `requireRole("Admin")` — circular-feeling but acceptable for Phase 1 (Phase 2 replaces with `role:assign` permission) |
| 1.9 | Default role on registration: auto-assign `Customer` in `registerUserService` | P1 | One transaction: create user + write `role_id` |
| 1.10 | Stop exposing `password` in `req.user` | **P0 — security** | `deserializeUser` selects only safe fields; remove `password` from the wire |
| 1.11 | Update `CLAUDE.md`, `docs/architecture.md`, `docs/updates.md` | P1 | Per the standing doc-update rule |
| 1.12 | Update `README.md` (if present) with the new seed/migration commands | P2 | Nice-to-have |

### Schema implications (locked decisions)

- **One role per user, permanently.** Phase 1 enforces this with a single nullable `role_id` FK on `users`. There is no `user_roles` join table and none will be added. If a future requirement seems to need "a user with two roles", solve it by introducing a new role name (e.g. `SalesManager`) — do not reach for a join table.
- **Registration writes `role_id = <Customer id>`** in the same transaction as `users.create`.
- **Promotion is admin-only.** No public endpoint accepts a role on registration. No "promote yourself to Admin" path exists.
- **No audit log in Phase 1.** Role-assignment observability is deferred. When the audit-log module lands (its own story, its own phase), role events become a typed subset.

### Phase 1 — As shipped (deviation from the original lock)

The original plan called for a `user_roles` join table with `@@unique([userId])` to keep role reassignment a pure data write. During implementation that was changed to a direct `role_id` FK on `users`, based on the following reasoning:

- **Phase 1 only needs one role per user.** A nullable FK is the minimal expression of that — no extra table, no extra unique constraint to maintain, and reassignment is still a data write (`UPDATE users SET role_id = ...`).
- **No multi-role is planned (see "Out of scope" above).** A join table earns its keep only when there's a one-to-many relationship. With one-role-per-user as a permanent decision, the join table is dead weight — extra storage, an extra index, an extra read on every role lookup.
- **Phase 2's `role_permissions` join is unaffected.** Phase 2 introduces a `permissions` table joined to `roles` via `role_permissions`. The `Users → Roles` shape doesn't need to change for that.

What did NOT change: the **Stories table, the "Out of scope" list, the Definition of Done, and the Known follow-ups** all still apply. The "Schema implications" wording above is the only corrected section.

### Phase 1 — Definition of Done

- [x] `roles` table exists in DB; `users.role_id` FK exists; migration committed
- [x] Seed script is idempotent and documented
- [x] Every existing user has `role_id` set to `Customer` (or to whichever role an admin has assigned)
- [x] New registrations land with `role_id = <Customer id>` automatically, in the same transaction as `users.create`
- [x] Reassigning a user's role overwrites `role_id` (FK semantics, not append)
- [x] `req.user` no longer contains `password` or other sensitive fields
- [x] `requireRole("Admin")` blocks non-admin users on the new role-assignment endpoints (verified end-to-end with a Customer login → 403)
- [x] No `prisma.users.roleId` *column* in any non-generated source file — it is an FK to the `roles` table
- [x] Docs updated (CLAUDE.md, architecture.md, updates.md, plan.md)
- [x] No regressions on existing auth/profile/email-change/forget-password flows
- [x] **No audit log table, no audit endpoint, no logging of role mutations** — explicitly out of scope for Phase 1

### Phase 1 — Known follow-ups (do **not** fix in Phase 1)

- `requireRole` is fine for Phase 1 but is exactly the pattern we want to stop using in Phase 2. **Document this** in `updates.md` so the next developer doesn't reach for it again.
- Hardcoding `Admin` in `requireRole("Admin")` for the role-assignment endpoint is a Phase-1-only compromise. Phase 2 replaces it with `requirePermission("role:assign")`.
- **Stale session roles.** If an admin reassigns a user's role via the API, that user's existing session still carries the old `roleNames` until the session is rotated. Out of scope for Phase 1.
- **First-Admin bootstrap.** The seed creates role rows only, not a user with `role_id = Admin`. Operators must promote their first Admin with a one-off SQL `UPDATE` (see `docs/updates.md` "Manual steps required" section).

---

## Phase 2 — Permissions + RolePermissions

### Scope

- New tables: `permissions`, `role_permissions`
- Seed an initial permission key namespace
- Wire `permissions` to roles via `role_permissions`
- New middleware: `requirePermission(...keys)` (and a convenience `requireAnyPermission` / `requireAllPermissions` if needed)
- Replace `requireRole("Admin")` with `requirePermission("role:assign")` on the role-assignment endpoints
- Loader: `loadUserPermissions` replaces `loadUserRoles` (or subsumes it)

### Permission key naming convention

Format: `<resource>:<action>[:<scope>]`

Examples for the current scope (no product tables yet):
- `user:read`, `user:read:self`, `user:update`, `user:update:self`, `user:delete`
- `role:read`, `role:assign`, `role:revoke`
- `profile:read:self`, `profile:update:self`

Future namespaces reserved but **not seeded**:
- `product:*`, `sales:*`, `recommendation:*`, `region:*` — added when those modules land

### Initial permission matrix (seed)

| Permission | Customer | Salesman | Admin |
|---|---|---|---|
| `profile:read:self` | ✓ | ✓ | ✓ |
| `profile:update:self` | ✓ | ✓ | ✓ |
| `user:read` |  |  | ✓ |
| `user:update` |  |  | ✓ |
| `user:delete` |  |  | ✓ |
| `role:read` |  |  | ✓ |
| `role:assign` |  |  | ✓ |
| `role:revoke` |  |  | ✓ |

No `product:*` / `sales:*` permissions yet — those land with their respective modules.

### Stories (priority order)

| # | Story | Priority | Notes |
|---|---|---|---|
| 2.1 | Schema: add `Permissions` + `RolePermissions` | **P0 — blocker** | |
| 2.2 | Migration: `npx prisma migrate dev --name add_rbac_phase2` | **P0 — blocker** | Separate from Phase 1 — keeps history clean |
| 2.3 | Extend seed script: insert permission keys + role_permissions joins per matrix above | P0 | Idempotent; safe to re-run |
| 2.4 | `authService` (or new `rbacService`): `findUserPermissions`, `findRolePermissions` | P0 | |
| 2.5 | Middleware: `requirePermission(...keys)` and `requireAnyPermission(...keys)` | P0 | Single key for the common case; the `*Any` variant only when a route genuinely has multiple valid keys |
| 2.6 | Loader: `loadUserPermissions` (fetches role names + permission keys in one query) | P0 | Replaces `loadUserRoles` |
| 2.7 | Replace `requireRole("Admin")` on role-assignment endpoints with `requirePermission("role:assign")` | P0 | |
| 2.8 | Lint guard (dev-only): warn when a protected route has no `requireRole` / `requirePermission` after `isAuthenticate` | P2 | Catches forgotten gates before they ship |
| 2.9 | Admin endpoint: `GET /api/admin/permissions` — list all permission keys | P2 | Powers future admin UI |
| 2.10 | Admin endpoint: `POST /api/admin/roles/:roleName/permissions` — attach a permission to a role | P2 | Restricted to non-system roles in Phase 2 (system roles are still mutable but flagged) |
| 2.11 | Update docs: phase 2 entry in `updates.md`; middleware inventory in `architecture.md` | P1 | |
| 2.12 | **Remove `requireRole` from new code** — add a one-line comment in `requireRole.mjs` marking it Phase-1-only | P2 | Prevents future copy-paste |

### Phase 2 — Definition of Done

- [ ] `permissions` and `role_permissions` tables exist; migration committed
- [ ] Seed matrix matches the table above exactly; idempotent
- [ ] `requirePermission("role:assign")` blocks all non-admin users
- [ ] No new controller/service code uses `requireRole` (only legacy role-assignment endpoint, which is replaced in story 2.7)
- [ ] All protected routes have an explicit `requirePermission` (or `requireRole` for Phase-1 routes that still need it)
- [ ] `req.auth.permissionKeys` is available wherever `req.auth.roleNames` is
- [ ] Docs reflect Phase 2 — middleware inventory, role matrix, the "do not use `requireRole` for new code" rule

---

## Cross-Cutting Decisions (apply to both phases)

### Where middleware lives
- `middleware/auth.mjs` — `isAuthenticate` (session check)
- `middleware/loadUserContext.mjs` — single loader that attaches `req.auth = { userId, roleNames, permissionKeys, isActive }`. Phase 1 ships `roleNames` only; Phase 2 adds `permissionKeys`.
- `middleware/requireRole.mjs` — Phase 1 only
- `middleware/requirePermission.mjs` — Phase 2 only

### What `req.auth` looks like
```js
req.auth = {
  userId,           // string (uuid)
  isActive,         // boolean
  roleNames,        // string[]                 (Phase 1)
  permissionKeys,   // string[]                 (Phase 2)
}
```
`req.user` becomes the **minimal session payload** (just `userId` + `isActive`). All other fields are loaded on-demand by services — never blanket-attached to `req`.

### Migration strategy
- Each phase is **one migration**. Phase 1 + Phase 2 = two migrations, easy to roll back independently.
- Seed is **idempotent** (upsert by natural key). Re-running it is a no-op.
- Seed runs **only** via `npm run seed:rbac` — never on app boot, never in CI without explicit opt-in.
- Backfill (existing users → `Customer`) lives in the same seed script.
- **No direct DB writes during development** — every role/permission mutation goes through the service layer so the Phase-1 logging hook (story 1.13) and the future audit log see every change. The seed script is the only exception, and it's the explicit bootstrap path.

### Rollback story
- Phase 1 rollback: drop the two new tables; remove the loader + middleware; revert `deserializeUser` to its old select. No data loss to existing tables.
- Phase 2 rollback: drop `permissions` + `role_permissions`; revert routes to `requireRole`; keep the seed script in tree but skip it.
- A phase is "releasable backward" only if every story in it is independently deployable. The order above is the deployment order.

### Things explicitly NOT in either phase
- No product/mobile/region/business tables
- No JWT or token-based auth — sessions stay
- No role hierarchy / inheritance
- No audit log (its own future phase — not Phase 1, not Phase 2)
- No "feature flag" system
- No multi-tenant scoping
- No "soft-delete" on roles or permissions
- No UI work — backend only

---

## Open Questions

**None — all resolved before implementation. Decisions are baked into the Schema implications block and the Phase 1 Definition of Done.**

### Decisions log

| # | Question | Decision | Where it's enforced |
|---|---|---|---|
| 1 | One role per user or many? | **One. Permanently.** Every user has zero or one role via a single `users.role_id` FK to `roles`. **Never a join table, never a `user_roles`, ever.** If a future requirement looks like "this user needs two roles", solve it by introducing a new role name (e.g. `SalesManager`) — do not reach for a join table | `users.role_id` FK is nullable; no other role storage exists |
| 2 | Registration role assignment? | **Always `Customer`.** No public endpoint accepts a role at registration. Admins promote later via the admin-only endpoint | Story 1.9 (registration default) + story 1.8 (admin endpoint) |
| 3 | Role-assignment logging before the audit-log module lands? | **No.** Deferred to a future audit-log phase. No `role_audit_logs` table, no admin-only read endpoint, no logging of role mutations in Phase 1 | Phase 1 DoD checklist explicitly excludes it |
| 4 | `requireRole("Admin")` on role-assignment endpoints in Phase 1? | **Acceptable Phase-1 compromise.** Phase 2 replaces with `requirePermission("role:assign")`. Doc this explicitly so the Phase-1-only status is obvious | Story 2.7 + the "do not use `requireRole` for new code" rule (story 2.12) |

---

## Timeline Shape (no dates — just ordering)

- Phase 1 stories must ship in the order listed (1.1 → 1.3 are the hard blockers; 1.4–1.10 can be batched as long as the wire-up is consistent; 1.11/1.12 close the phase).
- Phase 2 stories ship in the order listed (2.1 → 2.3 are blockers; 2.4–2.7 are the core; 2.8–2.12 are hardening + docs).
- Phase 2 does **not** start until Phase 1 is "done" by its Definition of Done.

---

## Risks Tracked Across Both Phases

| Risk | Phase | Mitigation |
|---|---|---|
| Destructive migration on a populated DB | Both | Per CLAUDE.md — `prisma migrate status` before any change; never drop tables without explicit user approval |
| `password` leak via `req.user` | Phase 1 | Story 1.10 — ships in Phase 1, **not** deferred |
| Future `if (user.role === ...)` copy-paste | Phase 1 → Phase 2 | Story 2.12 + lint guard (2.8) |
| Permission key sprawl | Phase 2 | Namespace convention enforced in seed; review per module |
| Stale session permissions after role change | Phase 2 | Out of scope for now; document the limitation; address when an explicit invalidation story lands |
| Circular "Admin requires Admin to assign Admin" | Phase 1 | Acceptable Phase-1 compromise; resolved cleanly in Phase 2 via `role:assign` |
| Forgetting a `requirePermission` on a new route | Phase 2 | Story 2.8 (lint guard) |

---

## What "Done With RBAC" Looks Like

After both phases ship:

- Every protected route has a single, explicit `requirePermission("...")` call
- New roles are insert-only (no schema changes)
- New permissions are insert-only (no schema changes)
- Role/permission changes can be made via admin API without a deployment
- `req.auth` is the only auth context passed around; `req.user` is minimal
- `password` and other sensitive fields never leave the service layer
- Future modules (product, sales, recommendation) add their own permission namespaces without touching the auth code
- Documentation reflects the matrix, the middleware inventory, and the "no `requireRole` for new code" rule