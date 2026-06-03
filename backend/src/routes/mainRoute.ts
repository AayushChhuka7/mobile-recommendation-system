import { Router } from "express";
import { userRouter } from "./userRoutes";

export const router = Router();

router.use("/api/users", userRouter);
