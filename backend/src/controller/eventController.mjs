// eventController — Step B end-points.
//
//   POST /api/events            → log a single interaction event
//   GET  /api/events/behavior/me → return the rolled-up behaviour map
//
// All routes require `isAuthenticate` — anonymous behaviour tracking
// is out of scope (we'd need device-fingerprinting + GDPR consent to
// do it right).

import { sendCreated, sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as eventService from "../services/eventService.mjs";

/**
 * POST /api/events
 *
 * Body: { eventType, phoneId?, payload? }
 *
 * Logs the event AND updates the user's BehaviourScore table in a
 * single transaction. The FE should fire-and-forget this — it
 * shouldn't block any UX path on the response.
 *
 * Returns `{ eventId, updatedTags }` so the FE can confirm what was
 * recorded without having to re-fetch.
 */
export const postEvent = catchAsync(async (req, res) => {
  const data = req.data || req.body || {};
  const { eventType, phoneId, payload } = data;

  if (!eventType) {
    throw badRequest("eventType is required");
  }

  const result = await eventService.recordEvent(
    req.user.userId,
    eventType,
    phoneId || null,
    payload || null,
  );

  return sendCreated(
    res,
    {
      eventId: result.event.eventId,
      eventType: result.event.eventType,
      createdAt: result.event.createdAt,
      updatedTags: result.updatedTags,
    },
    { message: "Event recorded" },
  );
});

/**
 * GET /api/events/behavior/me
 *
 * Returns the user's full behaviour score map for debugging / UI
 * preview ("what does the system think you like?"). Step D reads the
 * same map server-side; this endpoint exists so the FE can render a
 * "your interests" panel in the future.
 */
export const getBehavior = catchAsync(async (req, res) => {
  const scores = await eventService.loadBehaviorScores(req.user.userId);
  return sendSuccess(res, scores, { message: "Behaviour scores loaded" });
});