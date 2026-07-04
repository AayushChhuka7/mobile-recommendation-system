// requireRole(...roleNames) — Story 1.5
//
// Phase-1-only gate. Checks `req.auth.roleNames` (populated by
// `loadUserContext`). Pass = user holds at least one of the named roles.
//
// IMPORTANT: This is intentionally narrow. Phase 2 introduced
// `requirePermission(...keys)` and the rule is "no new controller /
// service code should reach for requireRole again". If you're adding a
// new gate, prefer `requirePermission`. As of Phase 2, this file has
// zero importers in the codebase; it stays in the tree so a future
// need can reach for it without re-deriving the shape, but new code
// should not import it.

import { asyncHandler } from "./errorHandler.mjs";

export const requireRole = (...roleNames) => {
  const allowed = roleNames.flat().filter(Boolean);

  return asyncHandler(async (req, res, next) => {
    const auth = req.auth;

    if (!auth || !auth.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!auth.isActive) {
      return res.status(403).json({ message: "Account is deactivated" });
    }


    let userRoles = [];
    if (Array.isArray(auth.roleNames)) {
      userRoles = auth.roleNames;
    }

   
    // roles and check membership against the allowed list. Stops at
    // the first match, same short-circuit behaviour as `.some()`.
    let hasAny = false;
    for (let i = 0; i < userRoles.length; i++) {
      if (allowed.includes(userRoles[i])) {
        hasAny = true;
        break;
      }
    }

    if (!hasAny) {
      return res.status(403).json({
        message: `Forbidden: requires one of roles [${allowed.join(", ")}]`,
      });
    }

    next();
  });
};