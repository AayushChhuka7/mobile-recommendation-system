// profileController — thin handlers for the self-service profile endpoints.
// All real work happens in services/profileService.mjs.

import { catchAsync } from "../utils/catchAsync.mjs";
import { sendSuccess } from "../utils/ApiResponse.mjs";
import {
  getExplicitPreferences,
  getFilterPreset,
  getProfileBundle,
  saveExplicitPreferences,
  saveFilterPreset,
} from "../services/profileService.mjs";

// GET /api/users/me/profile-bundle
// Returns { preference, customerProfile, lastRecommendation, lastSearches,
// lastBrowses } for the caller. Used by the Dashboard on first mount to
// hydrate the modal + listing state.
export const getOwnProfileBundle = catchAsync(async (req, res) => {
  const bundle = await getProfileBundle(req.user.userId);
  return sendSuccess(res, bundle, { message: "Profile bundle loaded" });
});

// GET /api/users/me/preferences
// Returns only the persona/weights/budget fields needed to pre-fill the
// "Recommend Me a Phone" modal. Lightweight alternative to the bundle.
export const getOwnPreferences = catchAsync(async (req, res) => {
  const prefs = await getExplicitPreferences(req.user.userId);
  return sendSuccess(res, prefs, { message: "Preferences loaded" });
});

// PUT /api/users/me/preferences
// Body: { persona, budgetMin?, budgetMax, weights? }
export const saveOwnPreferences = catchAsync(async (req, res) => {
  await saveExplicitPreferences(req.user.userId, req.data);
  return sendSuccess(res, null, { message: "Preferences saved" });
});

// GET /api/users/me/filter-preset
export const getOwnFilterPreset = catchAsync(async (req, res) => {
  const preset = await getFilterPreset(req.user.userId);
  return sendSuccess(res, preset, { message: "Filter preset loaded" });
});

// PUT /api/users/me/filter-preset
// Body: { filters: {...}, sort: 'newest' }
export const saveOwnFilterPreset = catchAsync(async (req, res) => {
  await saveFilterPreset(req.user.userId, req.data);
  return sendSuccess(res, null, { message: "Filter preset saved" });
});

// GET /api/users/me/profile (alias for bundle, used by the admin read at
// /:id/profile shape). Kept for symmetry so the FE can call one URL.
export const getOwnFullProfile = catchAsync(async (req, res) => {
  const bundle = await getProfileBundle(req.user.userId);
  return sendSuccess(res, bundle, { message: "Profile loaded" });
});
