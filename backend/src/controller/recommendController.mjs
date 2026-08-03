import { sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as recommendService from "../services/recommendService.mjs";
import {
  safeRecordCompareEvent,
  safeRecordRecommendationCall,
  safeRecordRecommendationEvent,
} from "../services/profileService.mjs";

export const getHealth = catchAsync(async (_req, res) => {
  const data = await recommendService.checkHealth();
  return sendSuccess(res, data, { message: "ML service healthy" });
});

export const postRecommend = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");
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
    // One row per *call* into RecommendationCall so the admin "Last
    // recommendation → Top results" panel can render the top-3 phones
    // from the most-recent call without fanning out into
    // RecommendationHistory. Also fire-and-forget.
    safeRecordRecommendationCall(req.user.userId, {
      persona: req.body.persona,
      budget: req.body.budget,
      results,
    });
  }

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
//
// Behaviour tracking policy (2026-08):
//   Dashboard auto-recommendations are READ-ONLY. The user did NOT
//   ask for them explicitly, so they must not pollute the
//   personalization pipeline. No `RecommendationHistory` rows, no
//   `RecommendationCall` snapshot, no `RecommendationLog` impressions,
//   no `Event` row, no `BehaviorScore` updates. The phones still
//   render identically in the UI — only the analytics side is silent.
//   The explicit "Recommend Me a Phone" click flow (handled by
//   `postRecommend` below) is the sole driver of behaviour updates.
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

  // `source: "auto"` is threaded into the service layer so the
  // internal `safeRecordRecommendationLog` impression write (which
  // lives inside `recommendService.getRecommendations`) is also
  // suppressed. Otherwise the auto flow would still leak impression
  // rows into `recommendation_logs` even though the controller-level
  // recommendation/RecommendationCall writes are gone.
  const { results, defaultedAt } = await recommendService.getAutoRecommendations(userId, {
    source: "auto",
  });

  // Intentionally NO `safeRecordRecommendationEvent` and NO
  // `safeRecordRecommendationCall` here. Auto-recommendations are
  // passive and must not feed the personalization pipeline.

  return sendSuccess(res, { results, defaultedAt }, {
    message: `Auto-recommend complete (${results.length} picks)`,
  });
});
