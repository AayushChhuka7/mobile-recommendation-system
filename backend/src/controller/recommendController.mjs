import { sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as recommendService from "../services/recommendService.mjs";
<<<<<<< HEAD
=======
import {
  safeRecordCompareEvent,
  safeRecordRecommendationEvent,
} from "../services/profileService.mjs";
>>>>>>> proxy-dev

export const getHealth = catchAsync(async (_req, res) => {
  const data = await recommendService.checkHealth();
  return sendSuccess(res, data, { message: "ML service healthy" });
});

export const postRecommend = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");
<<<<<<< HEAD
  const results = await recommendService.getRecommendations(req.body);
=======
  // Step C — pass the caller's userId so profileFusion can read
  // BehaviorScore rows and combine them with the FE-supplied (or
  // stored) explicit preferences. Behaviour nudges are per-request
  // and never persisted; the fusion result lives only for this call.
  const userId = req.user && req.user.userId ? req.user.userId : null;
  const results = await recommendService.getRecommendations(req.body, userId);

  // Implicit signal: log the served recommendation into
  // RecommendationHistory and bump the customer's totals. Fire-and-
  // forget so analytics never breaks the response.
  if (req.user && req.user.userId) {
    safeRecordRecommendationEvent(req.user.userId, {
      persona: req.body.persona,
      budget: req.body.budget,
      results,
    });
  }

>>>>>>> proxy-dev
  return sendSuccess(res, results, {
    message: `Found ${results.length} recommendations`,
  });
});

export const postCompareML = catchAsync(async (req, res) => {
  if (!req.body || !req.body.modelNameA || !req.body.modelNameB) {
    throw badRequest("modelNameA and modelNameB are required");
  }
  const result = await recommendService.compareWithML(
    req.body.modelNameA,
    req.body.modelNameB,
  );
<<<<<<< HEAD
  return sendSuccess(res, result, { message: "ML comparison complete" });
});
=======

  // Implicit signal: log the compare event into ComparisonHistory and
  // bump the customer's totals. Fire-and-forget so analytics never
  // breaks the response.
  if (req.user && req.user.userId) {
    safeRecordCompareEvent(req.user.userId, {
      modelNameA: req.body.modelNameA,
      modelNameB: req.body.modelNameB,
    });
  }

  return sendSuccess(res, result, { message: "ML comparison complete" });
});

// Auto-recommend — fired by the FE on Dashboard mount so the user sees
// personalized picks as soon as they land on the dashboard, without
// having to click "Recommend Me".
//
// No required body. Reads persona + budget from the stored profile
// (Step A explicit preferences) and lets Profile Fusion (Step C) +
// Ranking (Step D) do the rest. Returns the same per-candidate shape
// as `POST /recommend`, so the FE renders identically.
export const getAutoRecommend = catchAsync(async (req, res) => {
  const userId = req.user && req.user.userId ? req.user.userId : null;
  if (!userId) {
    // Anonymous users can't have stored preferences. The FE shouldn't
    // call this unauthenticated — guard with 401 instead of a silent
    // empty list so the misuse is visible.
    return sendSuccess(res, { results: [], defaultedAt: { persona: false, budget: false } }, {
      message: "No session — auto-recommend skipped",
    });
  }

  const { results, defaultedAt } = await recommendService.getAutoRecommendations(userId);

  // Implicit signal: log the auto-recommend as a recommendation event.
  // Same shape as the click flow so the persona + budget + count are
  // captured in RecommendationHistory. Fire-and-forget.
  if (results.length > 0) {
    safeRecordRecommendationEvent(userId, {
      persona: "auto",
      budget: { auto: true, defaultedAt },
      results,
    });
  }

  return sendSuccess(res, { results, defaultedAt }, {
    message: `Auto-recommend complete (${results.length} picks)`,
  });
});
>>>>>>> proxy-dev
