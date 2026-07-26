// profileRoutes — Step A end-points. Mounted at /api/profile in main.mjs.
//
// Endpoints:
//   GET   /me        — load the saved profile (or null if not onboarded)
//   POST  /onboard   — first-time / idempotent save
//   PATCH /me        — partial update of demographic + preference + derived
//
// All routes require an authenticated session. The user is taken from
// `req.user.userId` (Passport).

import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  onboardProfileValidation,
  patchProfileValidation,
} from "../validation/profileValidation.mjs";
import {
  getProfile,
  onboardProfile,
  patchProfile,
} from "../controller/profileController.mjs";

export const profileRoutes = Router();

profileRoutes.use(isAuthenticate);

// Allowed top-level keys per route. PATCH /me takes only the three
// sub-objects, so unknown keys are rejected.
const ONBOARD_ALLOWED = [
  "persona",
  "budget",
  "preferences",
  "maxBudget",
  "usageType",
  "cameraPreference",
  "preferredBrandId",
  "age",
  "gender",
  "country",
  "state",
  "city",
];

const PATCH_ALLOWED = ["profile", "preference", "customerProfile"];

profileRoutes.get("/me", getProfile);

profileRoutes.post(
  "/onboard",
  validationWith(onboardProfileValidation, ONBOARD_ALLOWED),
  onboardProfile,
);

profileRoutes.patch(
  "/me",
  validationWith(patchProfileValidation, PATCH_ALLOWED),
  patchProfile,
);
