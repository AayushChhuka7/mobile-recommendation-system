import { asyncHandler } from "./errorHandler.mjs";
import { findUserRoles } from "../services/rbacService.mjs";
import { unauthorized, accountDeactivated } from "../utils/ApiError.mjs";

export const loadUserContext = asyncHandler(async (req, res, next) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw unauthorized('Not authenticated');
  }

  if (!req.user.isActive) {
    throw accountDeactivated('Account is deactivated');
  }

  const roleNames = await findUserRoles(userId);

  req.auth = {
    userId,
    isActive: true,
    roleNames,
  };

  next();
});