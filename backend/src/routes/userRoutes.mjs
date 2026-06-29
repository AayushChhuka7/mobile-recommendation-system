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
import { loadUserRoles } from "../middleware/loadUserRoles.mjs";
import { loadUserById } from "../middleware/userLoader.mjs";
import { requireRole } from "../middleware/requireRole.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  assignRoleValidation,
  userCreationValidation,
  userUpdateValidation,
} from "../validation/userValidation.mjs";

export const userRoutes = Router();

// All admin endpoints require an authenticated, active session with
// `req.auth` populated. Role gating (`requireRole("Admin")`) follows.
userRoutes.use(isAuthenticate, loadUserRoles);

const adminOnly = requireRole("Admin");

// RBAC Phase 1 note: `requireRole("Admin")` is acceptable here as a
// Phase-1 compromise. Phase 2 replaces this with
// `requirePermission("role:assign")`. See docs/updates.md.
const ROLE_NAME_PATTERN = /^[A-Za-z]{1,50}$/;

userRoutes.get("/", adminOnly, getAllUser);
userRoutes.get("/:id", adminOnly, loadUserById, getUserById);
userRoutes.post(
  "/",
  adminOnly,
  validationWith(
    userCreationValidation,
    ["name", "email", "password", "confirmPassword", "phoneNo"],
  ),
  postUser,
);
userRoutes.patch(
  "/:id",
  adminOnly,
  loadUserById,
  validationWith(userUpdateValidation, ["name", "email", "password", "phoneNo"]),
  patchUser,
);
userRoutes.delete("/:id", adminOnly, loadUserById, deleteUser);

// ---- RBAC Phase 1 — admin role-assignment endpoints ----

userRoutes.post(
  "/:id/roles",
  adminOnly,
  loadUserById,
  validationWith(assignRoleValidation, ["roleName"]),
  assignUserRole,
);

userRoutes.delete(
  "/:id/roles/:roleName",
  adminOnly,
  loadUserById,
  (req, res, next) => {
    if (!ROLE_NAME_PATTERN.test(req.params.roleName)) {
      return res.status(400).json({ message: "Invalid roleName in URL" });
    }
    next();
  },
  revokeUserRole,
);
