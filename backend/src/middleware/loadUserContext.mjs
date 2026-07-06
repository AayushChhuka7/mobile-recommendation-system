// loadUserContext — Story 1.5 (was loadUserRoles, renamed in Phase 2
// then reverted on 2026-07-06. The filename is kept as
// `loadUserContext` for forward-compatibility if permissions ever
// return; the Phase 1 shape on `req.auth` is unchanged.)
//
// Session-context loader. Reads the user row attached by
// `deserializeUser` and resolves the user's role names into a single
// shape on `req.auth`:
//
//   req.auth = {
//     userId,           // string (uuid)
//     isActive,         // boolean
//     roleNames,        // string[]      // Phase 1 — primary gate surface
//   }
//
// `password` and other sensitive fields stay in the service layer.
// `req.user` is the minimal session payload (userId + isActive);
// everything else is loaded on-demand.

import { asyncHandler } from "./errorHandler.mjs";
import { findUserRoles } from "../services/rbacService.mjs";

export const loadUserContext = asyncHandler(async (req, res, next) => {
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
