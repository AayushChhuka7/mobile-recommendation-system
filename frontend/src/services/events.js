import api from "./api";

/**
 * Step B — fire-and-forget behaviour event.
 *
 *   POST /api/events
 *   {
 *     eventType: "search" | "view" | "click" | "compare" | "save" | "dismiss" | "ignore",
 *     phoneId?:   string (UUID),
 *     payload?:   { q?: string, query?: string, position?: number, ... }
 *   }
 *
 *   201 → { success: true, data: { eventId, eventType, createdAt, updatedTags }, message }
 *
 * The server applies the analyzer's decay + delta in the same
 * transaction, so a successful response means the BehaviourScore row
 * is updated. The FE does NOT need to do anything else — the
 * SearchHistoryScore service reads the same table on the next
 * recommendation request.
 *
 * Returns `null` on failure (network / 401). The logger hook treats
 * null as "silent retry next time" and never throws into the caller's
 * UI path.
 */
export async function postEvent({ eventType, phoneId, payload }) {
  try {
    const res = await api.post("/events", { eventType, phoneId, payload });
    return res?.data?.data ?? null;
  } catch (err) {
    // 401 = not logged in. Anything else is worth surfacing in the
    // console so we can debug, but never block the UI.
    if (err.response?.status !== 401) {
      console.warn("[postEvent] failed:", err);
    }
    return null;
  }
}

/**
 * Step B — fetch the user's rolled-up behaviour score map. Useful
 * for a future "what we think you like" preview panel; today's UI
 * doesn't render it directly, but it's exposed here so callers can
 * drop it in without a service change.
 *
 *   GET /api/events/behavior/me
 *   200 → { success: true, data: { "brand:Samsung": 4.2, ... } }
 */
export async function getBehavior() {
  try {
    const res = await api.get("/events/behavior/me");
    return res?.data?.data ?? {};
  } catch (err) {
    if (err.response?.status !== 401) {
      console.warn("[getBehavior] failed:", err);
    }
    return {};
  }
}