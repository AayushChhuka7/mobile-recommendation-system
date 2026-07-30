// profile.js — FE-side API client for the customer-profile endpoints.
//
// Mirrors the shape of services/phones.js and services/recommend.js:
// `axios` instance with credentials, success-envelope unwrapping, and
// JSDoc documenting the backend contract.
//
// All endpoints are self-service (mounted under /api/users/me/*) unless
// an explicit admin call (adminProfileRoutes) is added in a future task.

import api from "./api";

/**
 * GET /api/users/me/profile-bundle
 * 200 →
 *   {
 *     success: true,
 *     data: {
 *       user: { userId, name, email, phoneNo, isActive, isVerified, role },
 *       preference: { maxBudget, cameraPreference, usageType, preferredBrands },
 *       customerProfile: { budgetSegment, techTier, recommendationPersona,
 *                          avgBudget, searchCount, totalRecommendations,
 *                          totalComparisons, segmentConfidence, lastUpdated },
 *       lastRecommendation: { persona, budget, servedAt, topResults: [...] },
 *       lastSearches: [{ searchQuery, searchedAt }],
 *       lastBrowses:  [{ phoneLabel, brandName, viewedAt }],
 *     },
 *     message,
 *   }
 *
 * Returns `null` for `data` on the wire if the user has no profile yet
 * (fresh customer). The unwrap here normalises that to `null`.
 */
export async function getMyProfileBundle() {
  const res = await api.get("/users/me/profile-bundle");
  return res?.data?.data ?? null;
}

/**
 * GET /api/users/me/preferences
 * 200 →
 *   {
 *     success: true,
 *     data: {
 *       persona,
 *       budgetMin, budgetMax,
 *       usageType, cameraPreference,
 *       budgetSegment, segmentConfidence
 *     } | null
 *   }
 */
export async function getMyPreferences() {
  const res = await api.get("/users/me/preferences");
  return res?.data?.data ?? null;
}

/**
 * PUT /api/users/me/preferences
 * Body:
 *   {
 *     persona?: "gamer" | "camera" | "battery" | "allrounder" | "Custom",
 *     budgetMin?: number | "",
 *     budgetMax?: number | "",
 *     weights?: { gaming?: 1..5, camera?: 1..5, battery?: 1..5, display?: 1..5 }
 *   }
 * 200 → { success: true, message: "Preferences saved", data: null }
 */
export async function saveMyPreferences(payload) {
  const body = {};
  if (payload && typeof payload === "object") {
    if ("persona" in payload) body.persona = payload.persona;
    if ("budgetMin" in payload) body.budgetMin = payload.budgetMin;
    if ("budgetMax" in payload) body.budgetMax = payload.budgetMax;
    if ("weights" in payload && payload.weights) body.weights = payload.weights;
  }
  await api.put("/users/me/preferences", body);
  return true;
}

/**
 * GET /api/users/me/filter-preset
 * 200 →
 *   { success: true, data: { filters: {...}, sort: string|null, savedAt: string|null } }
 */
export async function getMyFilterPreset() {
  const res = await api.get("/users/me/filter-preset");
  return res?.data?.data ?? { filters: {}, sort: null };
}

/**
 * PUT /api/users/me/filter-preset
 * Body:
 *   {
 *     filters: {
 *       brand?: string, minPrice?: string, maxPrice?: string,
 *       minRam?: string, minBattery?: string, os?: string,
 *       has5G?: boolean, hasNfc?: boolean, hasOis?: boolean
 *     },
 *     sort?: "newest" | ... | "antutu"
 *   }
 * 200 → { success: true, message: "Filter preset saved", data: null }
 */
export async function saveMyFilterPreset(payload) {
  const body = {
    filters:
      payload && payload.filters && typeof payload.filters === "object"
        ? payload.filters
        : {},
    sort: payload && typeof payload.sort === "string" ? payload.sort : undefined,
  };
  await api.put("/users/me/filter-preset", body);
  return true;
}
