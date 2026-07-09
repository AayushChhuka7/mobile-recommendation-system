import { asyncHandler } from "./errorHandler.mjs";
import {
  unauthorized,
  accountDeactivated,
  forbidden,
} from "../utils/ApiError.mjs";

export const requireRole = (...roleNames) => {
  const allowed = roleNames.flat().filter(Boolean);

  return asyncHandler(async (req, res, next) => {
    const auth = req.auth;

    if (!auth || !auth.userId) {
      throw unauthorized("Not authenticated");
    }

    if (!auth.isActive) {
      throw accountDeactivated("Account is deactivated");
    }

    const userRoles = Array.isArray(auth.roleNames) ? auth.roleNames : [];

    const hasAny = userRoles.some((role) => allowed.includes(role));

    if (!hasAny) {
      throw forbidden(`Requires one of roles: [${allowed.join(", ")}]`);
    }

    next();
  });
};
