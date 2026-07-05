// roleGuard — login-time role check.
//
// Wraps `passport.authenticate("local")` with a custom verify
// callback. After passport verifies the password, this middleware
// checks the user's stored role against the `roleName` the FE sent
// in the login body. The DB is the source of truth, so the
// validator upstream is open-string — admins can log in, and a
// wrong role from the FE surfaces as a 303, not a 400.
//
// Wire order on `POST /login`:
//
//   validationWith(loginSchema, ["email", "password", "roleName"])
//     → roleGuard          // this file
//     → userLogin          // controller
//
// Why this sits between `validationWith` and the controller (rather
// than inside the passport strategy):
//   - The strategy doesn't know about `req.data` (validator output).
//   - The strategy doesn't know about role assignment at all — it
//     only verifies email + password.
//   - Doing the role check here keeps the strategy single-purpose
//     and keeps the role logic in middleware (where it belongs per
//     the project's layer rules).
//
// On role mismatch, the response is a 303 with a same-origin
// `Location` header pointing at `/api/auth/login-as/<correctRole>`.
// The FE's HTTP client follows the redirect, the FE's interceptor
// recognizes the convention path, and the FE re-POSTs the login
// with the corrected `roleName`. **No session is created on a
// mismatch** — `req.login()` is never called.

import passport from "passport";
import { asyncHandler } from "./errorHandler.mjs";
import { assertUserRoleMatches } from "../services/rbacService.mjs";

export const roleGuard = asyncHandler((req, res, next) => {
  passport.authenticate("local", async (err, user, info) => {
    // Mirror the default passport behavior: surface server errors
    // through the global error handler, and 401 on bad credentials.
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({
        message: info && info.message ? info.message : "Invalid credentials",
      });
    }

    // `req.data` is set by `validationWith`. If the validator
    // didn't run (programmer error), bail with a 500 rather than
    // silently letting the request through.
    const requestedRole = req.data && req.data.roleName;
    if (typeof requestedRole !== "string" || requestedRole.length === 0) {
      return next(new Error("roleGuard: req.data.roleName missing"));
    }

    const { matched, actualRole } = await assertUserRoleMatches(
      user.userId,
      requestedRole,
    );

    if (!matched) {
      // 303 + Location. `actualRole` is `null` only if the user has
      // no role at all (defensive — shouldn't happen post-Phase-1).
      // In that case the FE will receive a redirect to
      // `/api/auth/login-as/` and should treat it as "no role
      // assigned, contact support."
      const target = actualRole
        ? `/api/auth/login-as/${encodeURIComponent(actualRole)}`
        : "/api/auth/login-as/";
      res.status(303).set("Location", target).end();
      return;
    }

    // Match: log the user in and continue. `req.login` is
    // asynchronous (it serializes the user into the session) —
    // we wait for it before calling `next()` so the controller
    // sees `req.isAuthenticated() === true`.
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      next();
    });
  })(req, res, next);
});
