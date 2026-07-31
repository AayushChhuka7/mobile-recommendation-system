// eventController — thin handlers for the Step B event endpoints.
//
// All real work happens in services/behaviorAnalyzer.mjs. These handlers
// just translate (req) → (service call) → (envelope response).
//
// Endpoints:
//   POST /api/events              — record a behaviour event. Body is
//                                   already validated and trimmed by
//                                   validationWith(postEventValidation).
//   GET  /api/events/behavior/me  — return the calling user's
//                                   BehaviorScore rows, sorted desc.

import { catchAsync } from "../utils/catchAsync.mjs";
import { sendSuccess } from "../utils/ApiResponse.mjs";
import { prisma } from "../config/prisma.mjs";
import { recordEvent } from "../services/behaviorAnalyzer.mjs";

// POST /api/events
// body (already validated): { eventType, phoneId?, payload? }
export const postEvent = catchAsync(async (req, res) => {
  const { eventType } = req.data;
  const phoneId =
    typeof req.data.phoneId === "string" && req.data.phoneId.trim().length > 0
      ? req.data.phoneId.trim()
      : null;
  const payload =
    req.data.payload && typeof req.data.payload === "object"
      ? req.data.payload
      : null;

  const { eventId, tagsUpdated } = await recordEvent(req.user.userId, eventType, {
    phoneId,
    payload,
  });

  return sendSuccess(
    res,
    { eventId, tagsUpdated },
    { message: "Event recorded" },
  );
});

// GET /api/events/behavior/me
// Returns the caller's BehaviorScore rows as [{ tag, score, updatedAt }]
// sorted by score desc so the FE / admin can render the top tags.
export const getBehavior = catchAsync(async (req, res) => {
  const rows = await prisma.behaviorScore.findMany({
    where: { userId: req.user.userId },
    orderBy: [{ score: "desc" }, { tag: "asc" }],
    select: { tag: true, score: true, updatedAt: true },
  });
  return sendSuccess(
    res,
    rows.map((r) => ({
      tag: r.tag,
      score: Number(r.score),
      updatedAt: r.updatedAt,
    })),
    { message: "Behaviour scores loaded" },
  );
});
