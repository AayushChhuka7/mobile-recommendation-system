import { sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as recommendService from "../services/recommendService.mjs";
import {
  safeRecordCompareEvent,
  safeRecordImpressionBatch,
  safeRecordRecommendationCall,
  safeRecordRecommendationEvent,
} from "../services/profileService.mjs";

export const getHealth = catchAsync(async (_req, res) => {
  const data = await recommendService.checkHealth();
  return sendSuccess(res, data, { message: "ML service healthy" });
});

// Pull the FE's per-mount requestId out of the X-Request-Id header
// or the JSON body. The header is the canonical place — the FE mints
// the UUID once when the user lands on the dashboard and re-sends it
// on every follow-up call. The body field is a fallback for callers
// that don't set headers (curl, tests).
const extractRequestId = (req) => {
  const fromHeader = req && req.headers && req.headers["x-request-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  const fromBody = req && req.body && req.body.requestId;
  if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
  return null;
};

export const postRecommend = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");
  const userId = req.user && req.user.userId ? req.user.userId : null;
  const requestId = extractRequestId(req);

  // Pass `source: "click"` (default) so the impression log is tagged
  // for the trainer (#3). requestId is required for the impression
  // upsert key.
  const response = await recommendService.getRecommendations(req.body, userId, {
    source: "click",
    requestId,
  });

  // The new response shape (#8) is { results, lazy, totalRanked, eagerCount }.
  // The legacy controllers and tests expect `results`. We unwrap
  // here so the rest of the codebase doesn't have to change.
  const results = response && Array.isArray(response.results) ? response.results : response;

  // Implicit signal: log the served recommendation into
  // RecommendationHistory and bump the customer's totals. Fire-and-
  // forget so analytics never breaks the response.
  if (userId) {
    safeRecordRecommendationEvent(userId, {
      persona: req.body.persona,
      budget: req.body.budget,
      results,
    });
    safeRecordRecommendationCall(userId, {
      persona: req.body.persona,
      budget: req.body.budget,
      results,
    });
  }

  return sendSuccess(res, response, {
    message: `Found ${results.length} recommendations`,
  });
});

// Fix #8 — lazy expansion. The FE calls this as the user scrolls
// past `eagerCount`. Re-runs the full pipeline but only enriches
// the [offset, offset+limit) window so the per-call cost stays
// bounded.
export const postRecommendSlice = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");
  const userId = req.user && req.user.userId ? req.user.userId : null;
  const requestId = extractRequestId(req);
  const offset = Number.isFinite(req.body.offset) ? Math.max(0, req.body.offset) : 60;
  const limit = Number.isFinite(req.body.limit) ? Math.max(1, Math.min(60, req.body.limit)) : 30;

  const slice = await recommendService.getRecommendationsSlice(req.body, userId, {
    source: "click",
    requestId,
    offset,
    limit,
  });
  return sendSuccess(res, slice, {
    message: `Slice ${offset}..${offset + (slice.results?.length || 0)}`,
  });
});

// Fix #1 — FE-driven impression batch endpoint. The FE posts
// dwell/skip/click deltas here every 5s (or on visibilitychange).
// The handler upserts by (userId, phoneId, source, requestId) so
// multiple deltas in a session collapse to one row.
export const postImpression = catchAsync(async (req, res) => {
  const userId = req.user && req.user.userId ? req.user.userId : null;
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  if (!userId || events.length === 0) {
    return sendSuccess(res, { ok: true, applied: 0 });
  }
  const applied = await safeRecordImpressionBatch(userId, events);
  return sendSuccess(res, { ok: true, applied });
});

export const postCompareML = catchAsync(async (req, res) => {
  if (!req.body || !req.body.modelNameA || !req.body.modelNameB) {
    throw badRequest("modelNameA and modelNameB are required");
  }
  const result = await recommendService.compareWithML(
    req.body.modelNameA,
    req.body.modelNameB,
  );

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
// Behaviour tracking policy (updated 2026-08 — Fix #1):
//   Dashboard auto-recommendations are now NOT silent on the
//   analytics side. The impression log is written with `source =
//   "auto"` and the FE's per-mount `requestId` so the trainer
//   (#3) can pick it up. The legacy `RecommendationHistory` and
//   `RecommendationCall` writes remain SUPPRESSED here — the user
//   did not ask for these phones, so they should not bump the
//   customer's recommendation counter. The trainer filters on
//   `is_training_eligible` (set true by the FE's
//   `POST /impressions` when dwell >= 1.5s && !skipped) so noisy
//   "scrolled past" impressions don't pollute the regression.
export const getAutoRecommend = catchAsync(async (req, res) => {
  const userId = req.user && req.user.userId ? req.user.userId : null;
  if (!userId) {
    return sendSuccess(res, {
      results: [],
      lazy: [],
      totalRanked: 0,
      eagerCount: 0,
      defaultedAt: { persona: false, budget: false },
    }, {
      message: "No session — auto-recommend skipped",
    });
  }

  const requestId = extractRequestId(req);
  const response = await recommendService.getAutoRecommendations(userId, {
    source: "auto",
    requestId,
  });
  // `getAutoRecommendations` returns { results, defaultedAt } OR
  // (Fix #8) { results, lazy, totalRanked, eagerCount, defaultedAt }.
  // Normalise so the FE always sees the same shape.
  const normalised = response && Array.isArray(response.results)
    ? response
    : { results: response?.results || [], lazy: [], totalRanked: response?.results?.length || 0, eagerCount: response?.results?.length || 0, defaultedAt: response?.defaultedAt || { persona: false, budget: false } };

  return sendSuccess(res, normalised, {
    message: `Auto-recommend complete (${normalised.results.length} picks)`,
  });
});
