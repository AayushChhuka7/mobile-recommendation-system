import { Router, Request, Response } from "express";
import {
  createUser,
  deleteUser,
  getAllUsers,
  getUserById,
  updateUser,
} from "../dtos/user.dto";
import { attachUser } from "../middleware/userMiddleware";

export const userRouter = Router();

//.../api/users
userRouter.get("/", getAllUsers);

userRouter.get("/:id", attachUser, getUserById);
userRouter.post("/", createUser);

userRouter.patch("/:id", attachUser, updateUser);
userRouter.delete("/:id", attachUser, deleteUser);
