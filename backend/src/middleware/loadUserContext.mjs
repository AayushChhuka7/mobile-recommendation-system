// loadUserContext — Story 2.6 (replaces Phase 1's loadUserRoles)
//
// Session-context loader. Reads the user row attached by
// `deserializeUser` and resolves the user's role names + permission
// keys into a single shape on `req.auth`:
//
//   req.auth = {
//     userId,           // string (uuid)
//     isActive,         // boolean
//     roleNames,        // string[]                 (Phase 1, kept for
//                                                //   `requireRole` only)
//     permissionKeys,   // string[]                 (Phase 2, primary
//                                                //   gate surface)
//   }
//
// `password` and other sensitive fields stay in the service layer.
// `req.user` is the minimal session payload (userId + isActive);
// everything else is loaded on-demand.

import { asyncHandler } from "./errorHandler.mjs";
import { findUserPermissions, findUserRoles } from "../services/rbacService.mjs";

export const loadUserContext = asyncHandler(async (req, res, next) => {
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const roleNames = await findUserRoles(userId);
  const permissionKeys = await findUserPermissions(userId);
  const isActive = Boolean(req.user.isActive);

  req.auth = {
    userId,
    isActive,
    roleNames,
    permissionKeys,
  };

  next();
});
