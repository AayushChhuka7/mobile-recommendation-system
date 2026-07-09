import { Router } from "express";
import {
  getAllPhones,
  getPhoneById,
  searchPhones,
  getPhonesByBrand,
  getFilterOptions,
  getPhoneStats,
} from "../controller/phoneController.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";

export const phoneRoutes = Router();

// phoneRoutes.use(isAuthenticate);

// IMPORTANT: Static routes BEFORE dynamic routes

phoneRoutes.get("/filters", getFilterOptions); // ← Add
phoneRoutes.get("/stats", getPhoneStats);
// GET /api/phones/search?q=iPhone
phoneRoutes.get("/search", searchPhones);

// GET /api/phones/brand/:brandName
phoneRoutes.get("/brand/:brandName", getPhonesByBrand);

// GET /api/phones — List all
phoneRoutes.get("/", getAllPhones);

// GET /api/phones/:id — Detail (dynamic route LAST)
phoneRoutes.get("/:id", getPhoneById);
