# System Flows

This document explains how requests move through the backend — middleware chain,
session state, `req.user` / `req.session` / `req.data` lifecycle, and every error
branch. Use it as a reference when adding endpoints or debugging.

> Legend: `─▶` happy path, `┿` decision, `╳` terminal error, `□` external side effect,
> `◇` writes to session / DB.

---

## Table of Contents

1. [Boot & Middleware Chain](#1-boot--middleware-chain)
2. [The `req` Object Lifecycle](#2-the-req-object-lifecycle)
3. [Registration → Verify (OTP)](#3-registration--verify-otp)
4. [Login](#4-login)
5. [Logout](#5-logout)
6. [Resend OTP (Registration)](#6-resend-otp-registration)
7. [Forget Password (Three-Step)](#7-forget-password-three-step)
8. [Change Password While Logged In](#8-change-password-while-logged-in)
9. [Change Email (Two-Step, Authenticated)](#9-change-email-two-step-authenticated)
10. [Self-Service Profile (`/users/me`)](#10-self-service-profile-usersme)
11. [Admin User CRUD (`/users/:id`)](#11-admin-user-crud-usersid)
12. [Deactivate Own Account](#12-deactivate-own-account)
13. [Admin Role Assignment (`/users/:id/roles`)](#13-admin-role-assignment-usersidroles)
14. [OTP State Machine (Unified)](#14-otp-state-machine-unified)
15. [Session Keys Reference](#15-session-keys-reference)
16. [Error Codes Cheatsheet](#16-error-codes-cheatsheet)

---

## 1. Boot & Middleware Chain

```
src/index.mjs
    │
    ▼
express.json() / urlencoded / cookieParser
    │
    ▼
express-session  ── store: Postgres (connect-pg-simple), TTL 3 min
    │
    ▼
passport.initialize() + passport.session()
    │
    ▼
GET  /                          ── "Home"
POST /api/*                     ── router (routes/main.mjs)
    │
    ▼
404 catch-all                    ── "No PAGE"
    │
    ▼
errorHandler                     ── last-resort JSON error
```

### Global Request Lifecycle

```
Client
  │  POST /api/auth/login
  │  headers: Cookie: connect.sid=…
  │  body:   { email, password }
  ▼
express ─── json / urlencoded ─── cookieParser ─── session ─── passport ─── router
                                                                              │
                                                                              ▼
                                                             authRoutes (/auth)
                                                                              │
                                                                              ▼
                                                       passport.authenticate("local")
                                                                              │
                                                            success  ▼       │ fail
                                                                       next() │
                                                                              ▼
                                                                       userLogin
                                                                              │
                                                                              ▼
                                                                     res.json(200)
                                                                              │
                                                                              ▼
                                                                errorHandler (if thrown)
```

> **Key idea:** every endpoint hits `session → passport` first. Passport's
> `deserializeUser` is what hydrates `req.user` from the `connect.sid` cookie.

---

## 2. The `req` Object Lifecycle

Each middleware mutates `req` in a predictable way. Controllers only ever
read from these properties — they don't have to know which middleware set them.

| Property | Set by | Read by | Purpose |
|---|---|---|---|
| `req.body` | `express.json()` | validators, controllers | Raw request body |
| `req.params` | Express router | `loadUserById` | URL params (e.g. `:id`) |
| `req.data` | `validationWith` final handler | controllers, services | Whitelisted + sanitized fields, `password` is **hashed** here |
| `req.session.pendingUserId` | `registerUser` controller | `verifyOtp` | Registration flow anchor |
| `req.session.forgetUserId` | `forgetPassword` controller | `verifyOtp`, services | Password-reset flow anchor |
| `req.session.pendingEmail` | `requestEmailChange` controller | `verifyOwnOtp`, services | Email-change flow anchor |
| `req.session.validOtpId` | `verifyOtp` / `verifyOwnOtp` | `isOtpVerified`, services | "OTP was just verified" gate |
| `req.user` | passport.deserializeUser | `isAuthenticate`, `loadUserRoles`, controllers, services | Hydrated user row from DB (safe select — no `password`) |
| `req.auth` | `loadUserRoles` middleware | `requireRole`, controllers (read-only) | `{ userId, isActive, roleNames: string[] }` — Phase 1 RBAC auth context |
| `req.checkUser` | `loadUserById` middleware | `getUserById`, `patchUser`, `deleteUser`, role-assignment controllers | Admin route lookup target |
| `req.isAuthenticated()` | passport | `isAuthenticate` | Boolean — is session live? |

### Visual: how a request accumulates state

```
┌────────────────────────────────────────────────────────────────────────┐
│ Incoming request (no req.user, no req.data)                            │
└────────────────────────────────────────────────────────────────────────┘
                                    │
   ┌────────────────────────────────┼─────────────────────────────────┐
   ▼                                ▼                                 ▼
express.json()               express-session                     passport.session()
req.body ◀ raw               req.session ◀ cookie row           req.user ◀ deserialize
   │
   ▼
validationWith(schemas, allowed)
   ├─ 400 if validationResult not empty
   ├─ 400 if any body key ∉ allowedFields
   ├─ hash data.password if present
   └─ req.data ◀ matchedData(whitelisted)
   │
   ▼
verifyOtp / verifyOwnOtp   (writes req.session.validOtpId)
   │
   ▼
isOtpVerified              (re-checks DB row from req.session.validOtpId)
   │
   ▼
loadUserRoles              (RBAC Phase 1 — sets req.auth from req.user)
   │
   ▼
requireRole("Admin")?      (optional gate; reads req.auth.roleNames)
   │
   ▼
controller reads { req.body, req.data, req.session.*, req.user, req.auth }
```

> Middleware order on a protected route is:
> `isAuthenticate → loadUserRoles → (optional) requireRole → controller`
> Phase 2 will insert `loadUserPermissions` between `loadUserRoles` and
> `requireRole` / `requirePermission`, but `loadUserRoles` stays.

---

## 3. Registration → Verify (OTP)

### 3.1 `POST /api/auth/register`

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/auth/register                                        │
│          { name, email, password, confirmPassword, phoneNo? }           │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
       validationWith(userCreationValidation, allowedFields)
       ┿  validation errors? ──────────────────────────────▶ 400 { error: [...] }
       ┿  unknown body keys?  ──────────────────────────────▶ 400 { message }
                                  │
                                  ▼
                req.data = { name, email, password (hashed), phoneNo? }
                                  │
                                  ▼
                       registerUserService(req.data)
                                  │
                ┌─────────────────┼─────────────────────┐
                ▼                 ▼                     ▼
       findRoleByName      generateOtp()         prisma.otp.create
       ("Customer")              │                      │
                │                │       ┌──────────────┘
                ▼                ▼       ▼
       prisma.$transaction:
         users.create({
           ...data,
           roleId: customerRole.roleId    ◀── one-role-per-user (Phase 1)
         })
                                            │
                                            ▼
                                   sendEmail(email, code)
                                            │
                                            ▼
                       req.session.pendingUserId = newUser.userId
                                            │
                                            ▼
                       201 { message: "Registration successful.",
                             userId }
```

> **RBAC Phase 1:** every new user lands with `role_id = <Customer id>`,
> written in the same transaction as `users.create`. If the seed hasn't
> been run, registration fails with `500 "Service not initialized.
> Contact support."` — the message is intentionally generic so the
> endpoint doesn't leak operational state.

### 3.2 `POST /api/auth/verify` (Registration OTP)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/auth/verify                                          │
│          { otp }                                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                          verifyOtp middleware
                                  │
   ┿  no pendingUserId AND no forgetUserId? ──▶ 500 { message: "Internal
                                                       server Error" }
                                  │
                                  ▼
         userId   = req.session.pendingUserId
         purpose  = "Registration"   (because pendingUserId exists)
                                  │
                                  ▼
                findValidOtp(otp, userId, "Registration")
                                  │
   ┿  no row? ─────▶ 400 "Invalid OTP code or email."
   ┿  isUsed?  ────▶ 400 "This OTP has already been used."
   ┿  expired? ────▶ 400 "This OTP has expired."
                                  │
                                  ▼
              req.session.validOtpId = validOtp.otpId
                                  │
                                  ▼
                       verifyEmailService(req)
                                  │
              ┌───────────────────┴──────────────────┐
              ▼                                      ▼
   prisma.users.update                  prisma.otp.update
   set isVerified = true                set isUsed = true
              │                                      │
              └──────────── prisma.$transaction ─────┘
                                  │
                                  ▼
              delete req.session.pendingUserId
              delete req.session.validOtpId
                                  │
                                  ▼
                       200 { message: "Verification complete" }
```

> ⚠ The session **must** be retained between `/register` and `/verify`.
> The OTP row is only created on `/register` — the second request would
> fail to find one if the session expired or cookies were cleared.

---

## 4. Login

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/auth/login                                           │
│          { email, password }                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        authRoutes.post("/login", passport.authenticate("local"), userLogin)
                                  │
                                  ▼
       passport-local strategy (userStrategy.mjs)
                                  │
   passport.use(new Strategy({ usernameField: "email" }, async (email, password, done) => {
       findUserByEmail(email)
       ┿ not found?  ─────────────────▶ done(error("User not found"))
       verifyPassword(password, user.password)
       ┿ invalid?   ─────────────────▶ done(error("Invalid Credential"))
       user.isVerified?
       ┿ false?    ─────────────────▶ done(error("please verified your account"))
                                  │
                                  ▼
                            done(null, findUser)   ── success
   }))
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
       passport.serializeUser             passport.session()
       done(null, userId)                  stores session row in Postgres
                │                                   │
                └─────────────┬─────────────────────┘
                                  ▼
                       req.user ◀ full user row (via deserializeUser)
                                  │
                                  ▼
                        res.clearCookie NOT called
                                  │
                                  ▼
                            userLogin controller
                                  │
                                  ▼
                res.status(200).json({ message: "Login successful",
                                       user: { id, email } })
```

### Login error matrix

| Failure | Where | Response |
|---|---|---|
| Email doesn't exist | strategy | `401 "User not found"` |
| Wrong password | strategy | `401 "Invalid Credential"` |
| User not verified | strategy | `401 "please verified your account"` |
| Missing email/password | passport default | `400 Bad Request` |

### What `req.user` looks like after login (Phase 1 RBAC)

```
req.user = {
  userId:     "uuid",
  name:       "...",
  email:      "...",
  phoneNo:    "..." | null,
  isActive:   true,
  isVerified: true,
  roleId:     "uuid" | null        ◀── FK to roles.role_id (nullable)
}
```

> **RBAC Phase 1 fix:** `req.user` no longer contains `password`. The local
> passport strategy still loads the full row (it needs the bcrypt hash to
> verify credentials), but only the safe subset above is attached to the
> session via `passport.deserializeUser`. `loadUserRoles` then reads
> `req.user.userId` to fetch the user's role name and populates
> `req.auth.roleNames` (see §2).

---

## 5. Logout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/auth/logout   (Cookie: connect.sid=…)                │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       isAuthenticate middleware
                                  │
   ┿ !req.isAuthenticated()? ──────▶ 401 "please login"
                                  │
                                  ▼
                       userLogoutService(req)
                                  │
   req.logout(err → …)            req.session.destroy(err → …)
        ┿ err?                      ┿ err?
   reject(err)                       │
                                     ▼
                                reject(new Error("Could not log out completely"))
                                     │
                                     ▼
                                  resolve()
                                  │
                                  ▼
                    res.clearCookie("connect.sid")
                    200 { message: "Logged out successfully" }
```

> The next request from this client will deserialize as `done(error, null)`,
> leaving `req.user = false`. `req.isAuthenticated()` then returns `false`.

---

## 6. Resend OTP (Registration)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/auth/resend  { email }                               │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                          resendOtpService(email)
                                  │
                  prisma.users.findUnique({ email })
                                  │
   ┿ not found? ─▶ 404 "User not found"
   ┿ isVerified? ▶ 400 "User is already verified, please log in"
                                  │
                                  ▼
                generateOtp() → code
                                  │
                                  ▼
                  prisma.$transaction
        ┌─────────────────────────┴─────────────────────────┐
        ▼                                                   ▼
 updateMany({ userId, isUsed:false },   otp.create({ userId,
 { isUsed: true })                       code,
                                          purpose: "Registration",
                                          expiresAt: now+5min })
        │                                                   │
        └────────────── single transaction ─────────────────┘
                                  │
                                  ▼
                          sendEmail(email, code)
                                  │
                                  ▼
                  200 "A new OTP has been sent successfully."
```

> No session involvement — the user may have lost their session and still
> trigger a resend by knowing their email.

---

## 7. Forget Password (Three-Step)

### Step 1 — `POST /api/auth/forget`

```
{ email }
   │
   ▼
validationWith(forgetPasswordValidation, ["email"])
   │
   ▼
forgetPasswordService(email)
   │
   ┿ user not found? ─▶ 404 "User not found. Please Register"
   │
   ▼
generateOtp() + prisma.$transaction(
   updateMany unused → used,
   otp.create { purpose: "PasswordReset", expiresAt: now+5min }
)
   │
   ▼
sendEmail(email, code)
   │
   ▼
req.session.forgetUserId = user.userId    ◀── session anchor
   │
   ▼
"verify the otp"
```

### Step 2 — `POST /api/auth/forget/verify`  { otp }

```
verifyOtp middleware
   │
   ┿ pendingUserId?  → purpose: "Registration"  ◀── (shouldn't happen here)
   ┿ forgetUserId?   → purpose: "PasswordReset" ◀── this branch
   ┿ neither?        → 500
   │
   ▼
findValidOtp(otp, forgetUserId, "PasswordReset")
   │
   ┿ not found / used / expired?  → 400
   │
   ▼
req.session.validOtpId = otpId
   │
   ▼
ackOtpVerified controller
   │
   ▼
200 "OTP verified. You may now change your password."
```

### Step 3 — `POST /api/auth/forget/changePassword`

```
{ password, confirmPassword }
   │
   ▼
isOtpVerified middleware
   │
   ┿ !req.session.validOtpId?  ──▶ 400 "OTP not verified"
   │
   ▼
findOtpById(req.session.validOtpId)
   │
   ┿ !otp | otp.isUsed | expired?
       delete req.session.validOtpId
       ──▶ 400 "OTP expired or already used. Please verify again."
   │
   ▼
validationWith(changePasswordValidation, ["password", "confirmPassword"])
   │
   ┿ validation fail / mismatch? ──▶ 400
   │
   ▼
verifyPasswordChangeService(req)
   │
   prisma.$transaction(
     users.update({ password: req.data.password (already hashed) }),
     otp.update({ isUsed: true })
   )
   │
   delete req.session.forgetUserId
   delete req.session.validOtpId
   │
   ▼
200 "Verification complete"
```

> The `isOtpVerified` middleware **re-reads the DB row** — closing the gap
> between `/forget/verify` (ack) and `/forget/changePassword` (commit). If
> 5 minutes elapse in between, the second step rejects even though the
> session still holds `validOtpId`.

### Failure matrix (forget flow)

| Stage | Failure | Response |
|---|---|---|
| `/forget` | unknown email | 404 "User not found" |
| `/forget/verify` | bad otp | 400 "Invalid OTP code or email." |
| `/forget/verify` | already used | 400 "This OTP has already been used." |
| `/forget/verify` | expired | 400 "This OTP has expired." |
| `/forget/changePassword` | no `validOtpId` | 400 "OTP not verified" |
| `/forget/changePassword` | DB row stale | 400 "OTP expired or already used. Please verify again." |
| `/forget/changePassword` | weak password / mismatch | 400 validation |

---

## 8. Change Password While Logged In

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  PATCH /api/users/me/password   (authenticated)                 │
│          { currentPassword, password, confirmPassword }                 │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       isAuthenticate   (uses req.user.userId)
                                  │
   ┿ !isAuth?  ─▶ 401 "please login"
                                  │
                                  ▼
  validationWith(changePasswordWhileLoggedInValidation,
                 ["currentPassword", "password", "confirmPassword"])
                                  │
   ┿ validation fail ─▶ 400
                                  │
                                  ▼
  req.data = { currentPassword (plain!), password (hashed), confirmPassword }
  ▲
  NOTE: only "password" is auto-hashed. "currentPassword" stays plain
        so the service can compare it against the saved bcrypt hash.
                                  │
                                  ▼
  changePasswordWhileLoggedInService(
    req.user.userId,
    req.body.currentPassword,      ◀── plain, from req.body not req.data
    req.data.password              ◀── already hashed
  )
                                  │
   prisma.users.findUnique({ userId })
   ┿ not found? ─▶ 404 "User Not Found"
                                  │
   verifyPassword(currentPasswordRaw, user.password)
   ┿ invalid?   ─▶ 403 "Current password is incorrect"
                                  │
                                  ▼
  prisma.users.update({ password: newHashedPassword })
                                  │
                                  ▼
  200 "Password changed successfully"
```

---

## 9. Change Email (Two-Step, Authenticated)

### Step 1 — `POST /api/auth/me/email/request`

```
{ currentPassword, newEmail }
   │
   ▼
isAuthenticate
   │
   ▼
loadUserRoles               ◀── RBAC Phase 1 — populates req.auth
   │
   ▼
validationWith(requestEmailChangeValidation,
               ["currentPassword", "newEmail"])
   │
   ▼
requestEmailChangeService(
  req.user.userId,
  req.body.currentPassword,
  req.data.newEmail         ◀── already trimmed by validator
)
   │
   ┿ user not found  ─▶ 404
   ┿ wrong password  ─▶ 403 "Current password is incorrect"
   ┿ newEmail === user.email ─▶ 400 "New email must be different..."
   │
   ▼
generateOtp() + prisma.$transaction(
  updateMany unused OTP → used,
  otp.create { purpose: "EmailChange", expiresAt: now+5min }
)
   │
   ▼
sendEmail(newEmail, code)
   │
   ▼
req.session.pendingEmail = req.data.newEmail
   │
   ▼
200 "OTP sent to new email. Please verify to complete the change."
```

### Step 2 — `POST /api/auth/me/email/verify`  { otp }

```
isAuthenticate  (req.user.userId required)
   │
   ▼
loadUserRoles               ◀── RBAC Phase 1 — populates req.auth
   │
   ▼
verifyOwnOtp middleware
   │
   ┿ no req.user?  ─▶ 401 "Not authenticated"
   ┿ no req.session.pendingEmail? ─▶ 400 "No pending email change request"
   │
   ▼
userId  = req.user.userId
purpose = "EmailChange"            (hard-coded)
   │
   ▼
findValidOtp(otp, userId, "EmailChange")
   │
   ┿ not found / used / expired?  ─▶ 400
   │
   ▼
req.session.validOtpId = otpId
   │
   ▼
verifyEmailChangeService(req)
   │
   ┿ !req.session.pendingEmail? ─▶ 400 "No pending email change request"
   │
   ▼
prisma.$transaction(
  users.update({ email: pendingEmail }),
  otp.update({ isUsed: true })
)
   │
   delete req.session.pendingEmail
   delete req.session.validOtpId
   │
   ▼
200 "Email changed successfully"
```

> Unlike `verifyOtp`, `verifyOwnOtp` uses `req.user.userId` (NOT session).
> The session anchor is `pendingEmail` (the address we're moving TO), not
> a userId.

---

## 10. Self-Service Profile (`/users/me`)

All routes here hit `isAuthenticate → loadUserRoles` first (router-level
middleware on `ownUserRoutes`). `req.auth` is available to every endpoint
in this router even though none of them currently gate by role.

### `GET /api/users/me`

```
isAuthenticate → loadUserRoles
   │
   ▼
getOwnProfile controller
   │
   destructure { userId, name, email, phoneNo, isActive, isVerified }
            from req.user
   │
   ▼
200 { userId, name, email, phoneNo, isActive, isVerified }
```

### `PATCH /api/users/me`

```
isAuthenticate → loadUserRoles → validationWith(updateOwnProfileValidation,
                                              ["name", "phoneNo"])
   │
   ▼
req.data = { name?, phoneNo? }     ◀── both optional, both trimmed
   │
   ▼
updateUser(req.user.userId, req.data)
   │
   ▼
200 { message: "Profile updated successfully", user: {...} }
```

> `email` and `password` are **not** patchable here on purpose — they
> have dedicated two-step flows (`/auth/me/email/*`, `/users/me/password`).

### `PATCH /api/users/me/password` — see §8.

### `POST /api/users/me/deactivate` — see §12.

---

## 11. Admin User CRUD (`/users/:id`)

> **RBAC Phase 1:** every route in `userRoutes` is gated by
> `isAuthenticate → loadUserRoles → requireRole("Admin")` at the router
> level. Reaching a controller requires an active session whose
> `req.auth.roleNames` includes `"Admin"`.

```
userRoutes = Router()
   .use(isAuthenticate, loadUserRoles)        ◀── sessions only
const adminOnly = requireRole("Admin");        ◀── Admins only

GET    /api/users
        adminOnly
        → getAllUser  → findAllUsers() → 200 [...] | 500 "No users found"
GET    /api/users/:id
        adminOnly
        loadUserById   → req.checkUser = findUserById(req.params.id)
        ┿ not found? ──▶ "User Not Found"
        → getUserById   → 200 req.checkUser
POST   /api/users
        adminOnly
        validationWith(userCreationValidation,
                       ["name", "email", "password", "confirmPassword", "phoneNo"])
        → postUser  → createUser(req.data)  → 201 newUser
PATCH  /api/users/:id
        adminOnly
        loadUserById
        validationWith(userUpdateValidation,
                       ["name", "email", "password", "phoneNo"])
        → patchUser → updateUser(req.checkUser.userId, req.data)
        → 200 { message, user }
DELETE /api/users/:id
        adminOnly
        loadUserById
        → deleteUser  → prisma.users.delete   ◀── hard delete
        → 200 "Deletion Complete"
```

> `requireRole("Admin")` is a Phase-1 compromise. Phase 2 swaps it for
> `requirePermission("role:assign")` (see `docs/plan.md` §Phase 2). Do
> not reach for `requireRole` on any new code without first checking
> whether `requirePermission` should exist instead.

> Note: `req.params.id` flows into `loadUserById` which **throws** if the
> user doesn't exist. The throw propagates to `errorHandler`.

---

## 12. Deactivate Own Account

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Client:  POST /api/users/me/deactivate                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                isAuthenticate → loadUserRoles
                                  │
                                  ▼
             deactivateOwnAccountService(req.user.userId)
                                  │
   prisma.users.update({ isActive: false })
                                  │
                                  ▼
              Promise.all-equivalent sequence:
        req.logout(err → reject)        ◀── passport clears session.user
            │
            ▼
        req.session.destroy(err → reject)  ◀── removes session row in PG
            │
            ▼
        res.clearCookie("connect.sid")
            │
            ▼
        200 "Account deactivated successfully"
```

> This is a **soft delete**. The user row stays in the DB; `isActive=false`.
> `findActiveUserById` exists in `userService` to gate deactivated accounts
> but is **not yet wired** into the passport strategy — see §14.

---

## 13. Admin Role Assignment (`/users/:id/roles`)

> **RBAC Phase 1.** Two endpoints, both gated by the same
> `isAuthenticate → loadUserRoles → requireRole("Admin")` chain as the
> other admin routes. There's no audit log — the assignment is a plain
> data write.

### Assign — `POST /api/users/:id/roles`

```
{ roleName: "Customer" | "Salesman" | "Admin" }
   │
   ▼
isAuthenticate → loadUserRoles → adminOnly
   │
   ▼
loadUserById               ◀── 404 "User Not Found" if :id missing
   │
   ▼
validationWith(assignRoleValidation, ["roleName"])
   ┿ unknown field?         ─▶ 400
   ┿ roleName not in {Customer, Salesman, Admin}? ─▶ 400 "roleName must be one of..."
   ▼
assignRole(req.checkUser.userId, req.data.roleName)
   │
   ┿ role missing (shouldn't happen if seed has run) ─▶ 404 "Role \"…\" does not exist"
   ▼
prisma.users.update({
  where: { userId },
  data:  { roleId: role.roleId },
})
   │
   ▼
200 {
  message: "Role \"<name>\" assigned to user <userId>",
  user: { userId, email, role: <roleName> }
}
```

### Revoke — `DELETE /api/users/:id/roles/:roleName`

```
isAuthenticate → loadUserRoles → adminOnly
   │
   ▼
loadUserById               ◀── 404 if :id missing
   │
   ▼
URL whitelist check (regex on :roleName)
   ┿ malformed roleName?    ─▶ 400 "Invalid roleName in URL"
   ▼
revokeRole(req.checkUser.userId)
   │
   ┿ user missing          ─▶ 404 "User not found"
   ▼
prisma.users.update({
  where: { userId },
  data:  { roleId: null },         ◀── roles row untouched
})
   │
   ▼
200 {
  message: "Role revoked for user <userId>",
  user: { userId, email, role: null }
}
```

### Failure matrix (role assignment)

| Stage | Failure | Response |
|---|---|---|
| `isAuthenticate` | not logged in | 401 "please login" |
| `loadUserRoles`   | no `req.user` | 401 "Not authenticated" |
| `requireRole("Admin")` | user's roles don't include `Admin` | 403 "Forbidden: requires one of roles [Admin]" |
| `requireRole("Admin")` | `isActive=false` | 403 "Account is deactivated" |
| `loadUserById`    | `:id` not found | 400 "User Not Found" |
| `validationWith`  | body has unknown keys | 400 |
| `validationWith`  | `roleName` not whitelisted | 400 "roleName must be one of: Customer, Salesman, Admin" |
| URL whitelist     | malformed `:roleName` | 400 "Invalid roleName in URL" |
| `assignRole`      | role row missing | 404 "Role \"…\" does not exist" |
| `assignRole` / `revokeRole` | user missing (race) | 404 "User not found" |

### Known limitations

- **Stale session.** If an admin reassigns a user's role, the user's
  existing session keeps its old `req.auth.roleNames` until the session
  is rotated (logout or expiry). Acceptable for Phase 1.
- **First-Admin bootstrap.** The seed creates role rows only, not a
  user with `role_id = Admin`. The very first Admin is created via a
  one-off SQL `UPDATE` — see `docs/updates.md` "Manual steps required".

---

## 14. OTP State Machine (Unified)

The `Otp` table is the source of truth. Each flow has its own `purpose` enum
and its own session anchor, but the row lifecycle is identical.

```
                    ┌────────────────────────────────────┐
                    │  purpose enum:                     │
                    │   • Registration   (anchor:        │
                    │     req.session.pendingUserId)     │
                    │   • PasswordReset  (anchor:        │
                    │     req.session.forgetUserId)      │
                    │   • EmailChange    (anchor:        │
                    │     req.session.pendingEmail +    │
                    │     req.user.userId)               │
                    └────────────────────────────────────┘

       GENERATE                                  CONSUME
  (send endpoint / verify success)         (verify endpoint success)
         │                                          │
         ▼                                          ▼
   ┌──────────┐                              ┌──────────┐
   │ isUsed=  │ ───── resend / new send ────▶│ row born │
   │  false   │                              │ isUsed=  │
   │  +       │                              │  false   │
   │ expiresAt│                              │ expiresAt│
   │ > now    │                              │ > now    │
   └──────────┘                              └────┬─────┘
                                                  │
                ┌─────────────────────────────────┤
                │                                 │
                ▼                                 ▼
         used=true (consume)            TTL elapsed (5 min)
                │                                 │
                ▼                                 ▼
         stays in DB                     stays in DB
         (audit / replay)                findValidOtp filters
                                         via expiresAt: { gt: now }
```

### Why `updateMany` on every send?

```js
prisma.$transaction([
  updateMany({ userId, isUsed: false }, { isUsed: true }),
  create({ userId, code, purpose, expiresAt })
])
```

> Guarantees only **one valid OTP per (user, purpose)** is in flight at a
> time. Combined with `findValidOtp`'s `isUsed: false, expiresAt: gt now`,
> this means a user can never accidentally reuse an old code.

### Where the OTP is verified

| Endpoint | Middleware | Purpose source |
|---|---|---|
| `POST /api/auth/verify` | `verifyOtp` | session: `pendingUserId` → `Registration` |
| `POST /api/auth/forget/verify` | `verifyOtp` | session: `forgetUserId` → `PasswordReset` |
| `POST /api/auth/me/email/verify` | `verifyOwnOtp` | `req.user.userId` → `EmailChange` (hard-coded) |

### `isOtpVerified` — the gate between two steps

`/forget/verify` returns ack → user can now call `/forget/changePassword`.
But what if the user pauses for 6 minutes? `isOtpVerified` re-reads the
DB row using `req.session.validOtpId` and rejects if the row has been
marked used or has expired since the original verification.

```
verifyOtp  (T=0)            isOtpVerified (T+1 min)        T+6 min
   │                            │                              │
   ▼                            ▼                              ▼
validOtpId ← session        re-read otp row                re-read otp row
isUsed=false,                isUsed=false,                  isUsed=false,
expiresAt > now              expiresAt > now                expiresAt < now
   │                            │                              │
   ▼                            ▼                              ▼
ack OK                        gate OK                         400 + delete session.validOtpId
```

---

## 15. Session Keys Reference

| Key | Type | Set by | Read by | Cleared by |
|---|---|---|---|---|
| `pendingUserId` | uuid | `registerUser` ctrl | `verifyOtp` | `verifyEmailService` |
| `forgetUserId` | uuid | `forgetPassword` ctrl | `verifyOtp`, `verifyPasswordChangeService` | `verifyPasswordChangeService` |
| `pendingEmail` | string | `requestEmailChange` ctrl | `verifyOwnOtp`, `verifyEmailChangeService` | `verifyEmailChangeService` |
| `validOtpId` | uuid | `verifyOtp` / `verifyOwnOtp` | `isOtpVerified`, services | `verifyEmailService`, `verifyPasswordChangeService`, `verifyEmailChangeService`, `isOtpVerified` (on stale) |
| `passport.user` | uuid | passport | passport | passport (on `req.logout`) |

> Cookie `connect.sid` carries the session id. It is cleared on logout
> and on account deactivation.

---

## 16. Error Codes Cheatsheet

| HTTP | Origin | Trigger |
|---|---|---|
| 400 | `validationWith` | express-validator chain failed |
| 400 | `validationWith` | body has keys outside `allowedFields` |
| 400 | `verifyOtp` / `verifyOwnOtp` | bad / used / expired OTP |
| 400 | `isOtpVerified` | session flag missing or DB row stale |
| 400 | `verifyOwnOtp` | no `pendingEmail` in session |
| 400 | `resendOtpService` | user already verified |
| 400 | `requestEmailChangeService` | new email equals current |
| 400 | `assignRoleValidation` | `roleName` not in the whitelist |
| 400 | `userRoutes` URL check | malformed `:roleName` in path |
| 401 | `isAuthenticate` | not logged in |
| 401 | `passport-local` | wrong email / password / unverified |
| 401 | `verifyOwnOtp` | no `req.user` |
| 401 | `loadUserRoles` | no `req.user.userId` |
| 403 | `changePasswordWhileLoggedInService` | wrong current password |
| 403 | `requestEmailChangeService` | wrong current password |
| 403 | `findActiveUserById` | `isActive=false` (planned, not wired) |
| 403 | `requireRole` | user lacks required role |
| 403 | `requireRole` | `isActive=false` |
| 404 | `resendOtpService` / `forgetPasswordService` | email unknown |
| 404 | `changePasswordWhileLoggedInService` / `requestEmailChangeService` | user missing |
| 404 | `findUserById` (admin) | `:id` not found |
| 404 | `assignRole` | role row missing |
| 404 | `assignRole` / `revokeRole` | target user missing |
| 500 | `verifyOtp` | no session anchor (programmer error) |
| 500 | `userLogoutService` | session destroy failed |
| 500 | `registerUserService` | `Customer` role not seeded (generic message) |
| 500 | default `errorHandler` | unhandled throw |

> The `errorHandler` final fallback always returns:
> ```json
> { "success": "false", "message": "<error.message>" }
> ```

---

## Appendix: Where each `req.*` is set

```
req.body                express.json() / urlencoded
req.params              Express router
req.cookies             cookieParser
req.session.*           express-session (connect-pg-simple)
req.user                passport.deserializeUser      (safe select — no password)
req.auth                loadUserRoles                (RBAC Phase 1: { userId, isActive, roleNames })
req.isAuthenticated()   passport
req.data                validationWith
req.checkUser           loadUserById
req.session.validOtpId  verifyOtp / verifyOwnOtp
req.session.pendingUserId   registerUser ctrl
req.session.forgetUserId    forgetPassword ctrl
req.session.pendingEmail    requestEmailChange ctrl
req.logout()            passport
req.session.destroy()   express-session
```

Middleware order on a protected route:
`isAuthenticate → loadUserRoles → (optional requireRole) → controller`

If you add a new endpoint, decide up front:
1. Which **middleware** guards it? (auth / OTP / validation)
2. Which **req keys** does it set vs. read?
3. Which **session keys** must be cleared on success?
4. Which **DB writes** happen in one transaction?
