import { Router } from "express";
import { userRoutes } from "./userRoutes.mjs";
import { ownUserRoutes } from "./ownUserRoutes.mjs";
import { authRoutes } from "./authRoutes.mjs";
import { productRoutes } from "./productRoutes.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";

export const router = Router();

router.use("/users", userRoutes);
router.use("/users", ownUserRoutes);
router.use("/auth", authRoutes);
router.use("/products", isAuthenticate, productRoutes);
