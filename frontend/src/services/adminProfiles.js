// adminProfiles.js — admin-only API client.
//
// Mirrors the JSDoc + envelope-unwrap pattern of services/profile.js.
//
// Endpoints:
//   GET /api/users                  → list every user (admin only)
//   GET /api/users/:id/profile      → full profile bundle for one user
//   GET /api/users/:id/behavior     → Step B BehaviorScore rows for one user
//
// All admin endpoints are gated server-side by `requireRole("Admin")` on
// `userRoutes` / `adminProfileRoutes` — a customer calling these gets
// 403. The FE also gates via `useAdminGuard` for UX, but the BE guard
// is the source of truth.

import api from "./api";

/**
 * GET /api/users
 * 200 →
 *   {
 *     success: true,
 *     data: [
 *       {
 *         userId, name, email, phoneNo,
 *         isActive, isVerified,
 *         role: "Customer" | "Admin" | "Salesman" | null
 *       },
 *       ...
 *     ],
 *     message,
 *   }
 *
 * Empty list → 404 with code `RESOURCE_NOT_FOUND`. The caller treats
 * a 404 as "no users" rather than an error.
 *
 * Note: the bcrypt `password` hash is intentionally NOT included in the
 * response. See `backend/src/services/userService.mjs` `findAllUsers`.
 */
export async function listAllUsers() {
  try {
    const res = await api.get("/users");
    return res?.data?.data ?? [];
  } catch (err) {
    // Backend throws RESOURCE_NOT_FOUND for empty list. Normalise to [].
    if (err?.response?.status === 404) return [];
    throw err;
  }
}

/**
 * GET /api/users/:id/profile
 * 200 →
 *   {
 *     success: true,
 *     data: {
 *       user: { userId, name, email, phoneNo, isActive, isVerified, role },
 *       preference: { maxBudget, cameraPreference, usageType, preferredBrands },
 *       customerProfile: {
 *         budgetSegment, techTier, recommendationPersona, avgBudget,
 *         searchCount, totalRecommendations, totalComparisons,
 *         segmentConfidence, lastUpdated
 *       },
 *       lastRecommendation: { persona, budget, servedAt, topResults: [{ phoneId, overallCompatibility, searchDate }] },
 *       lastSearches: [{ searchQuery, searchedAt }],
 *       lastBrowses:  [{ phoneLabel, brandName, viewedAt }],
 *     },
 *     message,
 *   }
 *
 * Errors:
 *   401 AUTH_NOT_AUTHENTICATED  → not logged in
 *   403 AUTH_FORBIDDEN_ROLE     → not an admin
 *   404 RESOURCE_NOT_FOUND      → userId doesn't exist
 */
export async function getCustomerProfileById(userId) {
  if (!userId) {
    throw new Error("getCustomerProfileById requires a userId");
  }
  const res = await api.get(`/users/${encodeURIComponent(userId)}/profile`);
  return res?.data?.data ?? null;
}

/**
 * GET /api/users/:id/behavior
 * Step B — admin-only read of the Step B BehaviorScore rows for any user.
 * 200 →
 *   {
 *     success: true,
 *     data: [{ tag: string, score: number, updatedAt: string }, ...],
 *     message
 *   }
 *
 * Returns `[]` (not null) when the user has no scores yet. Sorted by
 * score desc so the FE can render the top tags without re-sorting.
 *
 * Errors:
 *   401 AUTH_NOT_AUTHENTICATED  → not logged in
 *   403 AUTH_FORBIDDEN_ROLE     → not an admin
 *   404 RESOURCE_NOT_FOUND      → userId doesn't exist
 */
export async function getCustomerBehavior(userId) {
  if (!userId) {
    throw new Error("getCustomerBehavior requires a userId");
  }
  try {
    const res = await api.get(
      `/users/${encodeURIComponent(userId)}/behavior`,
    );
    return Array.isArray(res?.data?.data) ? res.data.data : [];
  } catch (err) {
    // 404 means the user exists but has no scores yet → empty list.
    if (err?.response?.status === 404) return [];
    throw err;
  }
}