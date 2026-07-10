import { Router } from "express";
import { userRoutes } from "./userRoutes.mjs";
import { ownUserRoutes } from "./ownUserRoutes.mjs";
import { authRoutes } from "./authRoutes.mjs";
import { phoneRoutes } from "./phoneRoutes.mjs";
import { productRoutes } from "./productRoutes.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";

export const router = Router();

// `ownUserRoutes` is mounted FIRST so the `/me` literal wins over
// `userRoutes`'s `/:id` matcher. Express tries routes in registration
// order; a request for `/users/me` reaches `ownUserRoutes` first and
// matches `/me` (self-service). A request for `/users/<uuid>` falls
// through to `userRoutes` and matches the admin `/:id` route.
router.use("/users", ownUserRoutes);
router.use("/users", userRoutes);
router.use("/auth", authRoutes);
router.use("/products", isAuthenticate, productRoutes);
router.use("/phones", phoneRoutes);
