import { Router } from "express";
import {
  deleteUser,
  getAllUser,
  getUserById,
  patchUser,
  postUser,
} from "../controller/userController.mjs";
import { loadUserById } from "../middleware/userLoader.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  userCreationValidation,
  userUpdateValidation,
} from "../validation/userValidation.mjs";

export const userRoutes = Router();

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
