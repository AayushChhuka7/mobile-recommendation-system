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
import { requireRole } from "../middleware/requireRole.mjs";
import { loadUserById } from "../middleware/userLoader.mjs";
import { validationWith } from "../middleware/validator.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import {
  assignRoleValidation,
  userCreationValidation,
  userUpdateValidation,
} from "../validation/userValidation.mjs";

export const userRoutes = Router();

// All admin endpoints require an authenticated, active session with
// `req.auth` populated. Phase 1 RBAC: a single `requireRole("Admin")`
// gate covers every route in this file.
userRoutes.use(isAuthenticate, loadUserContext);
userRoutes.use(requireRole("Admin"));

const ROLE_NAME_PATTERN = /^[A-Za-z]{1,50}$/;

userRoutes.get("/", getAllUser);
userRoutes.get("/:id", loadUserById, getUserById);
userRoutes.post(
  "/",
  validationWith(
    userCreationValidation,
    ["name", "email", "password", "confirmPassword", "phoneNo"],
  ),
  postUser,
);
userRoutes.patch(
  "/:id",
  loadUserById,
  validationWith(userUpdateValidation, ["name", "email", "password", "phoneNo"]),
  patchUser,
);
userRoutes.delete("/:id", loadUserById, deleteUser);

// ---- RBAC — role-assignment endpoints ----

userRoutes.post(
  "/:id/roles",
  loadUserById,
  validationWith(assignRoleValidation, ["roleName"]),
  assignUserRole,
);

userRoutes.delete(
  "/:id/roles/:roleName",
  loadUserById,
  (req, res, next) => {
    if (!ROLE_NAME_PATTERN.test(req.params.roleName)) {
      return next(badRequest("Invalid roleName in URL", { field: "roleName" }));
    }
    next();
  },
  revokeUserRole,
);
