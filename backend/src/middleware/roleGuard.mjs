import passport from "passport";
import { asyncHandler } from "./errorHandler.mjs";
import { assertUserRoleMatches } from "../services/rbacService.mjs";

export const roleGuard = asyncHandler((req, res, next) => {
  passport.authenticate("local", async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({
        message: info && info.message ? info.message : "Invalid credentials",
      });
    }
    const requestedRole = req.data && req.data.roleName;
    if (typeof requestedRole !== "string" || requestedRole.length === 0) {
      return next(new Error("roleGuard: req.data.roleName missing"));
    }

    const { matched, actualRole } = await assertUserRoleMatches(
      user.userId,
      requestedRole,
    );

    if (!matched) {
      const errorMessage = actualRole
        ? `Access denied. User has role "${actualRole}", but "${requestedRole}" was required.`
        : "Access denied. No role assigned to this user. Please contact support.";
    
    return res.status(403).json({
      message: errorMessage,
      actualRole: actualRole || null,
      requiredRole: requestedRole,
      userId: user.userId,
    });
  }
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      next();
    });
  })(req, res, next);
});
