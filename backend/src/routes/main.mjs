import { Router } from "express";
import { userRoutes } from "./userRoutes.mjs";
import { authRoutes } from "./authRoutes.mjs";
import { isAuthenticate } from "../middleware/userMiddleware.mjs";
export const router = Router();
router.use("/users", isAuthenticate, userRoutes);
router.use("/auth", authRoutes);
