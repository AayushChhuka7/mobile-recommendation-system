import { useCallback, useRef } from "react";
import { postEvent } from "../services/events";

/**
 * useEventLogger — Step B frontend hook.
 *
 * Single source of truth for "fire a behaviour event" across the
 * whole app. Components call `log({ eventType, phoneId, payload })`
 * and the hook:
 *
 *   1. Coalesces rapid duplicate fires of the SAME (eventType, phoneId)
 *      pair inside a short window so a user clicking 5 cards in 200ms
 *      doesn't spam the backend.
 *   2. Fire-and-forgets via `postEvent` — never blocks the UI.
 *   3. Returns `null` on the first unmounted call so React StrictMode
 *      double-invocations don't double-count.
 *
 * Usage:
 *
 *   const log = useEventLogger();
 *   <button onClick={() => log({ eventType: "save", phoneId: p.id })}>...</button>
 *
 * The hook deliberately returns a plain function (not a tuple) so
 * components can pass it directly to onClick without destructure noise.
 *
 * Coalescing rules (tweak DEDUPE_WINDOW_MS to taste):
 *   - Dedupe key = `${eventType}::${phoneId || ""}::${payloadKey}`
 *   - Within DEDUPE_WINDOW_MS, only the first fire sends; later fires
 *     in the window are swallowed.
 *
 * The hook never throws. All errors are swallowed inside `postEvent`.
 */
export function useEventLogger({ dedupeWindowMs = 800 } = {}) {
  const lastFiredRef = useRef(new Map());

  const log = useCallback(
    ({ eventType, phoneId, payload } = {}) => {
      if (!eventType) return;

      const payloadKey =
        payload && typeof payload === "object"
          ? JSON.stringify(payload, Object.keys(payload).sort())
          : "";

      const key = `${eventType}::${phoneId || ""}::${payloadKey}`;
      const now = Date.now();
      const last = lastFiredRef.current.get(key);

      if (last && now - last < dedupeWindowMs) {
        return;
      }

      lastFiredRef.current.set(key, now);

      // Schedule the fetch asynchronously so the click handler returns
      // immediately. We deliberately don't `await` here — the whole
      // point of a logger hook is "the UI doesn't wait on analytics".
      void postEvent({
        eventType,
        phoneId: phoneId || undefined,
        payload: payload || undefined,
      });
    },
    [dedupeWindowMs],
  );

  return log;
}