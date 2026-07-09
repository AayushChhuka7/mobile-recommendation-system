import { Router } from "express";
import { getAllPhones, getPhoneById } from "../controller/phoneController.mjs";

export const phoneRoutes = Router();
// phoneRoutes.use(isAuthenticate);
// GET /api/phones — List all phones with filtering & pagination
phoneRoutes.get("/", getAllPhones);

// GET /api/phones/:id — Get single phone detail
phoneRoutes.get("/:id", getPhoneById);
