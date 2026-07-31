// events.js — FE-side API client for the Step B behaviour event endpoints.
//
// Mirrors the JSDoc + envelope-unwrap pattern of services/profile.js and
// services/adminProfiles.js. All endpoints are self-service (mounted under
// /api/events) and require authentication — the BE rejects with 401 if no
// session cookie is present.

import api from "./api";

/**
 * POST /api/events
 * Body:
 *   {
 *     eventType: "search" | "view" | "compare" | "click" | "save" | "ignore" | "recommend",
 *     phoneId?: string (UUID),
 *     payload?: object // free-form context, e.g. { q: "ROG" } for search
 *   }
 * 200 →
 *   {
 *     success: true,
 *     data: { eventId, tagsUpdated: string[] },
 *     message
 *   }
 *
 * Errors:
 *   401 AUTH_NOT_AUTHENTICATED   → not logged in
 *   400 VALIDATION_INVALID_INPUT → bad eventType / phoneId / payload
 *
 * The hook wrapper (`useEventLogger`) swallows any thrown error so the
 * call is fire-and-forget from the caller's POV.
 */
export async function postEvent({ eventType, phoneId, payload }) {
  const body = { eventType };
  if (phoneId) body.phoneId = phoneId;
  if (payload && typeof payload === "object") body.payload = payload;
  const res = await api.post("/events", body);
  return res?.data?.data ?? null;
}

/**
 * GET /api/events/behavior/me
 * 200 →
 *   {
 *     success: true,
 *     data: [{ tag: string, score: number, updatedAt: string }, ...],
 *     message
 *   }
 *
 * Returns the caller's rolled-up per-tag BehaviourScores sorted by
 * score desc. Empty list → `[]` (not null) — the caller can detect
 * "no behaviour yet" with `.length === 0`.
 *
 * Errors:
 *   401 AUTH_NOT_AUTHENTICATED → not logged in
 */
export async function getMyBehavior() {
  try {
    const res = await api.get("/events/behavior/me");
    return Array.isArray(res?.data?.data) ? res.data.data : [];
  } catch (err) {
    // 401 is expected for an unauthenticated probe — return []. Anything
    // else gets re-thrown so the caller's loading state can react.
    if (err?.response?.status === 401) return [];
    throw err;
  }
}