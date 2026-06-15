import { Router } from "express";
import {
  deleteUser,
  getAllUser,
  getUserById,
  patchUser,
  postUser,
} from "../controller/userController.mjs";
import { checkId, validationWith } from "../middleware/userMiddleware.mjs";
import {
  userCreationValidation,
  userUpdateValidation,
} from "../validation/userValidation.mjs";
// import { validateAllowedKeys } from "../middleware/userMiddleware.mjs";

export const userRoutes = Router();

userRoutes.get("/", getAllUser);
userRoutes.get("/:id", checkId, getUserById);
userRoutes.post("/", validationWith(userCreationValidation), postUser);
userRoutes.patch(
  "/:id",
  checkId,
  validationWith(userUpdateValidation),
  patchUser,
);
userRoutes.delete("/:id", checkId, deleteUser);
