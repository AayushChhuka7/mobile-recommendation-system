import { Router } from "express";
import {
  getAllPhones,
  getPhoneById,
  searchPhones,
  getPhonesByBrand,
  getFilterOptions,
  getPhoneStats,
  comparePhones,
  getFeaturedPhones,
  getLatestPhones,
  getBestValuePhones,
  getSimilarPhones,
} from "../controller/phoneController.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";

export const phoneRoutes = Router();

// phoneRoutes.use(isAuthenticate);

// IMPORTANT: Static routes BEFORE dynamic routes

phoneRoutes.get("/filters", getFilterOptions);
phoneRoutes.get("/stats", getPhoneStats);
// GET /api/phones/search?q=iPhone
phoneRoutes.get("/search", searchPhones);
phoneRoutes.get("/featured", getFeaturedPhones);
phoneRoutes.get("/latest", getLatestPhones);
phoneRoutes.get("/best-value", getBestValuePhones);

// GET /api/phones/brand/:brandName
phoneRoutes.get("/brand/:brandName", getPhonesByBrand);

// POST routes
phoneRoutes.post("/compare", comparePhones);

// GET /api/phones — List all
phoneRoutes.get("/", getAllPhones);

// GET /api/phones/:id/similar — Content-Based "Related Phones"
// lookup for the FE phone-details page. Express matches this more
// specific path before falling through to the bare `:id` route
// below (a request for `/phones/abc/similar` has two path segments
// after `/phones/` and only `:id/similar` matches; `/phones/abc`
// still falls through to `:id`).
phoneRoutes.get("/:id/similar", getSimilarPhones);

// GET /api/phones/:id — Detail (dynamic route LAST)
phoneRoutes.get("/:id", getPhoneById);
