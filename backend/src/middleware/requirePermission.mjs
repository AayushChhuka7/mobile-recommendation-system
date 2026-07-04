// requirePermission(...permissionKeys) — Story 2.5
//
// Phase 2 gate. Checks `req.auth.permissionKeys` (populated by
// `loadUserContext`). Pass = user holds at least one of the named
// permission keys (OR-semantics, matching `requireRole`).
//
// This is the only gate new code should reach for. `requireRole`
// is Phase-1-only and exists only to keep any not-yet-migrated
// routes working.

import { asyncHandler } from "./errorHandler.mjs";

export const requirePermission = (...permissionKeys) => {
  const allowed = permissionKeys.flat().filter(Boolean);

  return asyncHandler(async (req, res, next) => {
    const auth = req.auth;

    if (!auth || !auth.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!auth.isActive) {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    let userPerms = [];
    if (Array.isArray(auth.permissionKeys)) {
      userPerms = auth.permissionKeys;
    }

    // Walk the user's permission keys, stop at first match against
    // the allowed list. Same short-circuit shape as `requireRole`.
    let hasAny = false;
    for (let i = 0; i < userPerms.length; i++) {
      if (allowed.includes(userPerms[i])) {
        hasAny = true;
        break;
      }
    }

    if (!hasAny) {
      return res.status(403).json({
        message: `Forbidden: requires one of permissions [${allowed.join(", ")}]`,
      });
    }

    next();
  });
};
