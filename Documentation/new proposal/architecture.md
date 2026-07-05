# Architecture

## Request Flow

```
Client → Routes → Controller → Service → Prisma → Database
```

Cross-cutting concerns (`auth`, `validation`, `OTP`, `error`) sit as middleware
between routes and controllers; pure helpers (hashing, email) sit in `utils/`.

## Folder Layout (`src/`)

```
src/
├── config/            # prisma client (PrismaPg adapter), SMTP transporter
├── utils/             # crypto (hash, verify, generateOtp), email
├── validation/        # express-validator schemas only
├── middleware/        # auth, errorHandler, validator, verifyOtp, verifyOwnOtp, isOtpVerified, userLoader
├── strategies/        # passport-local
├── services/          # business logic + Prisma (auth, user, rbac)
├── controller/        # thin req/res handlers (auth, user)
├── routes/            # endpoint wiring (main, auth, user, ownUser, product)
├── mockData/          # legacy mockUsers / OTPs (kept empty, no longer wired)
└── index.mjs          # express bootstrap (sessions via connect-pg-simple)
```

## Layer Responsibilities

| Layer | Responsibility | Forbidden |
|---|---|---|
| Routes | Wire middleware + controller | DB, business logic, inline validation |
| Controller | Read req, call services, write res | Prisma, hashing |
| Service | Business logic, Prisma access, return data | `res.json`, `req`, `next` |
| Middleware | req/res/next orchestration, call services | Inline business logic, schemas |
| Validation | Pure `checkSchema` schemas | DB, hashing |
| Utils | Pure helpers | Framework-aware code |
| Config | Initialize clients (prisma, transporter) | Anything else |

## Important Modules

* Auth Module — registration, login, OTP flows, password/email change
* User Profile Module — self-service profile (`/users/me/*`) + soft-deactivate
* Admin User Module — CRUD on `/users[/:id]` (currently unprotected)
* Product Module — stub router at `/products` behind `isAuthenticate`
* Recommendation Module *(planned)*
* Region Module *(planned)*

## Middleware Inventory

* `isAuthenticate` — session check (`req.isAuthenticated()`)
* `loadUserContext` — attaches `req.auth = { userId, isActive, roleNames: string[], permissionKeys: string[] }` from the session. **RBAC Phase 2.** Resolves role names and permission keys in two Prisma lookups (one for the role, one for the role's permission bundle).
* `requirePermission(...permissionKeys)` — gates a route to users holding at least one of the named permission keys. Reads `req.auth.permissionKeys`. **The only gate new code should reach for.** Variadic, OR-semantics — `requirePermission("user:read", "user:update")` passes if the user has either.
* `requireRole(...roleNames)` — Phase 1 only. **Deprecated for new code.** Kept in the tree for shape-reuse; as of Phase 2 it has zero importers.
* `validationWith(...schemas, allowedFields?)` — runs schemas; if `allowedFields` given, rejects unknown body keys (400); auto-hashes `data.password`; attaches `req.data`
* `loadUserById` — calls `findUserById` service, attaches to `req.checkUser`
* `verifyOtp` — **unauthenticated** OTP verify; resolves purpose from session (`pendingUserId` → `Registration`, `forgetUserId` → `PasswordReset`); sets `req.session.validOtpId`
* `verifyOwnOtp` — **authenticated** OTP verify (uses `req.user.userId`, purpose always `EmailChange`); also checks `req.session.pendingEmail`; sets `req.session.validOtpId`
* `isOtpVerified` — gate: requires `req.session.validOtpId` AND re-checks `expiresAt`/`isUsed` against DB; clears session flag on stale/used OTP
* `asyncHandler` / `errorHandler` — async wrapper and JSON error responder

## `req.auth` Shape (RBAC Phase 2)

```
req.auth = {
  userId,           // string (uuid)
  isActive,         // boolean
  roleNames,        // string[]      // Phase 1 — kept for `requireRole` only
  permissionKeys,   // string[]      // Phase 2 — primary gate surface
}
```

Built by `loadUserContext`. `req.user` carries only the safe fields (no `password`) populated by `passport.deserializeUser`. **The wire rule is: read `req.auth` for auth context, never `req.user.role` or `req.user.roleId`.**

## Session Keys Used

* `pendingUserId` — registration flow
* `forgetUserId` — forget-password flow
* `pendingEmail` — email-change flow (new email awaiting OTP verification)
* `validOtpId` — set by `verifyOtp` / `verifyOwnOtp`, required by `isOtpVerified`

## OTP Model

* `OtpPurpose` enum: `Registration | PasswordReset | EmailChange`
* Composite index on `(userId, purpose, isUsed, expiresAt)` for fast lookup of the latest valid OTP per flow
* On every fresh send, prior unused OTPs for the same user are flipped to `isUsed=true` in the same transaction as the new insert — so only one valid OTP per `(user, purpose)` exists at a time
* TTL: 5 minutes (`OTP_TTL_MS` in `services/authService.mjs`)

## Routing Map

```
/api
├── /auth                          authRoutes.mjs
│   ├── POST /login                passport.authenticate("local") → userLogin
│   ├── POST /register             validationWith + registerUser
│   ├── POST /verify               verifyOtp + verifyEmail      (Registration)
│   ├── POST /resend               resendOtp
│   ├── POST /forget               validationWith + forgetPassword
│   ├── POST /forget/verify        verifyOtp + ackOtpVerified   (PasswordReset)
│   ├── POST /forget/changePassword isOtpVerified + validationWith + changePassword
│   ├── POST /me/email/request     isAuthenticate + loadUserContext + validationWith + requestEmailChange
│   └── POST /me/email/verify      isAuthenticate + loadUserContext + verifyOwnOtp + verifyEmailChange
└── /users                         userRoutes.mjs  (admin, isAuthenticate + loadUserContext)
    ├── GET    /                   requirePermission("user:read") + getAllUser
    ├── GET    /:id                requirePermission("user:read") + loadUserById + getUserById
    ├── POST   /                   requirePermission("user:create") + validationWith + postUser
    ├── PATCH  /:id                requirePermission("user:update") + loadUserById + validationWith + patchUser
    ├── DELETE /:id                requirePermission("user:delete") + loadUserById + deleteUser
    ├── POST   /:id/roles          requirePermission("role:assign") + loadUserById + validationWith + assignUserRole
    └── DELETE /:id/roles/:roleName requirePermission("role:revoke") + loadUserById + revokeUserRole
    /users                         ownUserRoutes.mjs  (self-service, isAuthenticate + loadUserContext)
    ├── GET    /me                 getOwnProfile
    ├── PATCH  /me                 validationWith + updateOwnProfile
    ├── PATCH  /me/password        validationWith + changeOwnPassword
    └── POST   /me/deactivate      deactivateOwnAccount

/api/products                      productRoutes.mjs (all isAuthenticate — stub)
```