// useEventLogger.jsx — fire-and-forget hook for Step B behaviour events.
//
// Usage:
//   const logEvent = useEventLogger();
//   logEvent("click", { phoneId: p.id });
//   logEvent("search", { payload: { q: searchTerm } });
//
// Behaviour:
//   - Returns a stable callback. Safe to include in a `useEffect`
//     dependency list without causing re-renders.
//   - Errors are swallowed. We log them via console.warn so devs can
//     spot a misconfigured endpoint, but we never let an analytics
//     failure abort a user-facing interaction.
//   - Idempotent for "view" events: React 18+ StrictMode double-mounts
//     effects in dev, which used to produce two POSTs per phone-detail
//     page load. We dedupe "view" calls per phoneId inside a short
//     window (5 s) so dev-mode doesn't spam the Event/BehaviorScore
//     tables. Production builds also benefit: SPA route changes that
//     re-fire useEffect on the same phoneId are coalesced.
//
// Why fire-and-forget:
//   The useEventLogger is called from JSX click handlers, search
//     inputs, and detail-view useEffects. If `postEvent` throws, we'd
//     either need to gate the surrounding user interaction on the network
//     (bad UX) or wrap every caller in its own try/catch (noisy). The
//     hook centralises that swallow.
//
// When NOT to use:
//   - Anywhere the caller needs the returned `tagsUpdated` or wants
//     to surface errors (e.g. admin debug page). Call `postEvent` from
//     `services/events.js` directly in those cases.

import { useCallback } from "react";
import { postEvent } from "../services/events";

// Module-scoped dedupe set for "view" events. A single record per
// `(phoneId, epochSecond / 5)` bucket so dev-mode StrictMode double
// mounts collapse into one POST. Survives React unmount/remount within
// the same SPA session; resets on full page reload (which is fine —
// reload is a separate user action that should re-log).
const VIEW_DEDUPE_WINDOW_MS = 5000;
const recentViews = new Set();
function viewKey(phoneId) {
  // PhoneId-scoped bucket; falling back to "<none>:<bucket>" for
  // phoneId-less view calls so they still dedupe per-session.
  const bucket = Math.floor(Date.now() / VIEW_DEDUPE_WINDOW_MS);
  return `${phoneId || "<none>"}::${bucket}`;
}
function shouldLogView(phoneId) {
  const key = viewKey(phoneId);
  if (recentViews.has(key)) return false;
  recentViews.add(key);
  // Opportunistically prune entries older than 2 windows so the Set
  // doesn't grow unbounded during long sessions. Cheap: at most a few
  // dozen entries in the worst case.
  if (recentViews.size > 64) {
    const cutoff = Math.floor(Date.now() / VIEW_DEDUPE_WINDOW_MS) - 2;
    for (const k of recentViews) {
      const parts = k.split("::");
      const b = Number(parts[parts.length - 1]);
      if (Number.isFinite(b) && b < cutoff) recentViews.delete(k);
    }
  }
  return true;
}

export function useEventLogger() {
  return useCallback(async (eventType, opts = {}) => {
    if (!eventType) return;
    try {
      // Only "view" gets the dedupe treatment — clicks / compares / saves
      // / searches are intentional user actions and shouldn't be coalesced.
      if (eventType === "view" && !shouldLogView(opts.phoneId)) {
        return;
      }
      await postEvent({
        eventType,
        phoneId: opts.phoneId,
        payload: opts.payload,
      });
    } catch (err) {
      // Console-only. Never break the user-facing call site.
      // eslint-disable-next-line no-console
      console.warn("[useEventLogger]", eventType, err?.message || err);
    }
  }, []);
}