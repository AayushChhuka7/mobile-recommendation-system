import { Router } from "express";
import {
  assignUserRole,
  deleteUser,
  getAllUser,
  getUserById,
  patchUser,
  postUser,
  revokeUserRole,
} from "../controller/userController.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserContext } from "../middleware/loadUserContext.mjs";
import { loadUserById } from "../middleware/userLoader.mjs";
import { requirePermission } from "../middleware/requirePermission.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  assignRoleValidation,
  userCreationValidation,
  userUpdateValidation,
} from "../validation/userValidation.mjs";

export const userRoutes = Router();

// All admin endpoints require an authenticated, active session with
// `req.auth` populated. Per-permission gating follows.
userRoutes.use(isAuthenticate, loadUserContext);

// RBAC Phase 2: each admin route names the permission key it needs.
// `requireRole("Admin")` is gone from this file — `requireRole` is
// kept around as a Phase-1-only artifact, but no new code should
// import it.
const canReadUser = requirePermission("user:read");
const canCreateUser = requirePermission("user:create");
const canUpdateUser = requirePermission("user:update");
const canDeleteUser = requirePermission("user:delete");
const canAssignRole = requirePermission("role:assign");
const canRevokeRole = requirePermission("role:revoke");

const ROLE_NAME_PATTERN = /^[A-Za-z]{1,50}$/;

userRoutes.get("/", canReadUser, getAllUser);
userRoutes.get("/:id", canReadUser, loadUserById, getUserById);
userRoutes.post(
  "/",
  canCreateUser,
  validationWith(
    userCreationValidation,
    ["name", "email", "password", "confirmPassword", "phoneNo"],
  ),
  postUser,
);
userRoutes.patch(
  "/:id",
  canUpdateUser,
  loadUserById,
  validationWith(userUpdateValidation, ["name", "email", "password", "phoneNo"]),
  patchUser,
);
userRoutes.delete("/:id", canDeleteUser, loadUserById, deleteUser);

// ---- RBAC — role-assignment endpoints ----

userRoutes.post(
  "/:id/roles",
  canAssignRole,
  loadUserById,
  validationWith(assignRoleValidation, ["roleName"]),
  assignUserRole,
);

userRoutes.delete(
  "/:id/roles/:roleName",
  canRevokeRole,
  loadUserById,
  (req, res, next) => {
    if (!ROLE_NAME_PATTERN.test(req.params.roleName)) {
      return res.status(400).json({ message: "Invalid roleName in URL" });
    }
    next();
  },
  revokeUserRole,
);
