// ownProfileRoutes — self-service profile endpoints mounted under
// /api/users, BEFORE admin userRoutes so the `/me` literal wins.
//
// Endpoints:
//   GET    /me                   — full bundle (preference + customer profile + last signals)
//   GET    /me/profile           — alias of /me (symmetric with admin GET /:id/profile)
//   GET    /me/profile-bundle    — alias of /me
//   GET    /me/preferences       — explicit preference row (persona, weights, budget)
//   PUT    /me/preferences       — upsert explicit preference row
//   GET    /me/filter-preset     — last-used filters + sort
//   PUT    /me/filter-preset     — upsert last-used filters + sort

import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserContext } from "../middleware/loadUserContext.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  getOwnFilterPreset,
  getOwnFullProfile,
  getOwnPreferences,
  getOwnProfileBundle,
  saveOwnFilterPreset,
  saveOwnPreferences,
} from "../controller/profileController.mjs";
import {
  saveFilterPresetValidation,
  savePreferencesValidation,
} from "../validation/profileValidation.mjs";

export const ownProfileRoutes = Router();

// All endpoints below require an authenticated, active session.
// No role check — every logged-in user (Customer / Salesman / Admin) can
// read and write their own profile.
ownProfileRoutes.use(isAuthenticate, loadUserContext);

// Full bundle (preference + customer profile + recent signals).
ownProfileRoutes.get("/me", getOwnProfileBundle);
// Aliases so the FE can pick whichever URL feels natural.
ownProfileRoutes.get("/me/profile", getOwnFullProfile);
ownProfileRoutes.get("/me/profile-bundle", getOwnProfileBundle);

// Explicit "what the user actively told us" — the modal payload.
ownProfileRoutes.get("/me/preferences", getOwnPreferences);
ownProfileRoutes.put(
  "/me/preferences",
  validationWith(savePreferencesValidation, [
    "persona",
    "budgetMin",
    "budgetMax",
    "weights",
  ]),
  saveOwnPreferences,
);

// Implicit signal #0 — the last-used listing filter + sort.
ownProfileRoutes.get("/me/filter-preset", getOwnFilterPreset);
ownProfileRoutes.put(
  "/me/filter-preset",
  validationWith(saveFilterPresetValidation, ["filters", "sort"]),
  saveOwnFilterPreset,
);
