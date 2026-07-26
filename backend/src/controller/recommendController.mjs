import { sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as recommendService from "../services/recommendService.mjs";
import * as profileService from "../services/profileService.mjs";

export const getHealth = catchAsync(async (_req, res) => {
  const data = await recommendService.checkHealth();
  return sendSuccess(res, data, { message: "ML service healthy" });
});

export const postRecommend = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");

  // Step A — fall back to the stored profile when the FE doesn't
  // include persona / budget. Anonymous callers (no `req.user`) still
  // hit the public 400 path inside the service.
  const body = await recommendService.mergeWithStoredProfile(
    req.body,
    req.user,
  );

  const results = await recommendService.getRecommendations(body);
  return sendSuccess(res, results, {
    message: `Found ${results.length} recommendations`,
  });
});
