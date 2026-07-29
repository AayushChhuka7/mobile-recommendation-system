import { Router } from "express";
import { userRoutes } from "./userRoutes.mjs";
import { ownUserRoutes } from "./ownUserRoutes.mjs";
<<<<<<< HEAD
=======
import { ownProfileRoutes } from "./ownProfileRoutes.mjs";
import { adminProfileRoutes } from "./adminProfileRoutes.mjs";
>>>>>>> proxy-dev
import { authRoutes } from "./authRoutes.mjs";
import { phoneRoutes } from "./phoneRoutes.mjs";
import { productRoutes } from "./productRoutes.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";
import { recommendRoutes } from "./recommendRoutes.mjs";
<<<<<<< HEAD
=======
import { eventRoutes } from "./eventRoutes.mjs";
>>>>>>> proxy-dev

export const router = Router();

// `ownUserRoutes` is mounted FIRST so the `/me` literal wins over
// `userRoutes`'s `/:id` matcher. Express tries routes in registration
// order; a request for `/users/me` reaches `ownUserRoutes` first and
// matches `/me` (self-service). A request for `/users/<uuid>` falls
// through to `userRoutes` and matches the admin `/:id` route.
<<<<<<< HEAD
router.use("/users", ownUserRoutes);
router.use("/users", userRoutes);
=======
//
// Same trick applies to `ownProfileRoutes` (mounted just before
// `userRoutes` so /users/me/preferences wins over /users/:id/* in
// adminProfileRoutes).
router.use("/users", ownUserRoutes);
router.use("/users", ownProfileRoutes);
router.use("/users", userRoutes);
router.use("/users", adminProfileRoutes);
>>>>>>> proxy-dev
router.use("/auth", authRoutes);
router.use("/products", isAuthenticate, productRoutes);
router.use("/phones", phoneRoutes);
router.use("/recommend", recommendRoutes);
<<<<<<< HEAD
=======
// Step B — unified behaviour event log + per-tag behaviour score.
// Every authenticated user can log their own events and read their
// own rolled-up scores. No role check on this router.
router.use("/events", eventRoutes);
>>>>>>> proxy-dev
