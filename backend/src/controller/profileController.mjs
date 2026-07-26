// profileController — Step A end-points.
//
//   GET   /api/profile/me          → the user's saved profile
//   POST  /api/profile/onboard     → first-time save (idempotent)
//   PATCH /api/profile/me          → partial update
//
// All end-points require `isAuthenticate`. `req.user.userId` is the
// canonical user key — Passport's session populates it.

import { sendCreated, sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as profileService from "../services/profileService.mjs";

/**
 * GET /api/profile/me
 *
 * Returns the full saved profile (demographic + preference + derived).
 * If the user has never onboarded, returns `data: null` with a 200 —
 * the FE uses this to decide whether to show the questionnaire.
 */
export const getProfile = catchAsync(async (req, res) => {
  const profile = await profileService.findProfileByUserId(req.user.userId);
  return sendSuccess(res, profile, { message: "Profile loaded" });
});

/**
 * POST /api/profile/onboard
 *
 * Idempotent first-time save. Accepts either the FE questionnaire
 * shape (persona + budget + preferences) or the DB shape (maxBudget +
 * usageType + cameraPreference). The service normalises both.
 */
export const onboardProfile = catchAsync(async (req, res) => {
  // `req.data` is set by `validationWith` and contains only the fields
  // whitelisted in the allowedFields list of the route.
  const data = req.data || req.body || {};

  if (!hasAnyBudget(data)) {
    throw badRequest(
      "budget.max (or maxBudget) is required for onboarding",
    );
  }

  const saved = await profileService.onboardProfile(req.user.userId, data);
  return sendCreated(res, saved, { message: "Profile saved successfully" });
});

/**
 * PATCH /api/profile/me
 *
 * Partial update. Each top-level key (profile, preference,
 * customerProfile) is optional. The service uses `upsert` so a missing
 * row is created rather than failing the request.
 */
export const patchProfile = catchAsync(async (req, res) => {
  const data = req.data || req.body || {};
  const updated = await profileService.patchProfile(req.user.userId, data);
  return sendSuccess(res, updated, { message: "Profile updated" });
});

// ---- helpers ----

// Either `budget.max` or `maxBudget` (top-level) is sufficient. Used to
// reject obviously-empty onboard payloads before the DB layer complains.
function hasAnyBudget(body) {
  if (body.maxBudget !== undefined && body.maxBudget !== null) return true;
  if (body.budget && body.budget.max !== undefined && body.budget.max !== null)
    return true;
  return false;
}
