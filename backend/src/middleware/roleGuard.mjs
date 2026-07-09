import passport from "passport";
import { asyncHandler } from "./errorHandler.mjs";
import { assertUserRoleMatches } from "../services/rbacService.mjs";
import { unauthorized, forbidden, internal } from "../utils/ApiError.mjs";

export const roleGuard = asyncHandler((req, res, next) => {
  passport.authenticate("local", async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return next(
        unauthorized(info && info.message ? info.message : "Invalid credentials"),
      );
    }
    const requestedRole = req.data && req.data.roleName;
    if (typeof requestedRole !== "string" || requestedRole.length === 0) {
      // Programming error: the request reached roleGuard without a
      // `roleName`. Should be caught upstream by validation; if we
      // see it here, something is wired wrong.
      return next(internal("roleGuard: req.data.roleName missing"));
    }

    const { matched, actualRole } = await assertUserRoleMatches(
      user.userId,
      requestedRole,
    );

    if (!matched) {
      const errorMessage = actualRole
        ? `Access denied. User has role "${actualRole}", but "${requestedRole}" was required.`
        : "Access denied. No role assigned to this user. Please contact support.";

      return next(
        forbidden(errorMessage, {
          actualRole: actualRole || null,
          requiredRole: requestedRole,
          userId: user.userId,
        }),
      );
    }
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      next();
    });
  })(req, res, next);
});
