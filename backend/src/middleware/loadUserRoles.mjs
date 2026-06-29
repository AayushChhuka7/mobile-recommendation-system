// loadUserRoles — Story 1.6
//
// Phase 1 session-context loader. Reads the user row attached by
// `deserializeUser` and resolves the user's role names into a single
// shape on `req.auth`:
//
//   req.auth = {
//     userId,           // string (uuid)
//     isActive,         // boolean
//     roleNames,        // string[]                 (Phase 1)
//     // permissionKeys: string[]                  (Phase 2 — not yet)
//   }
//
// `password` and other sensitive fields stay in the service layer.
// `req.user` becomes the minimal session payload (userId + isActive);
// everything else is loaded on-demand.

import { asyncHandler } from "./errorHandler.mjs";
import { findUserRoles } from "../services/userService.mjs";

export const loadUserRoles = asyncHandler(async (req, res, next) => {
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const roleNames = await findUserRoles(userId);
  const isActive = Boolean(req.user.isActive);

  req.auth = {
    userId,
    isActive,
    roleNames,
  };

  next();
});