import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserRoles } from "../middleware/loadUserRoles.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  changeOwnPassword,
  deactivateOwnAccount,
  getOwnProfile,
  updateOwnProfile,
} from "../controller/userController.mjs";
import {
  changePasswordWhileLoggedInValidation,
  updateOwnProfileValidation,
} from "../validation/userValidation.mjs";

export const ownUserRoutes = Router();

ownUserRoutes.use(isAuthenticate, loadUserRoles);

ownUserRoutes.get("/me", getOwnProfile);
ownUserRoutes.patch(
  "/me",
  validationWith(updateOwnProfileValidation, ["name", "phoneNo"]),
  updateOwnProfile,
);
ownUserRoutes.patch(
  "/me/password",
  validationWith(changePasswordWhileLoggedInValidation, [
    "currentPassword",
    "password",
    "confirmPassword",
  ]),
  changeOwnPassword,
);
ownUserRoutes.post("/me/deactivate", deactivateOwnAccount);