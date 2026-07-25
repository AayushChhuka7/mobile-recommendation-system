import { sendSuccess } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";
import * as recommendService from "../services/recommendService.mjs";

export const getHealth = catchAsync(async (_req, res) => {
  const data = await recommendService.checkHealth();
  return sendSuccess(res, data, { message: "ML service healthy" });
});

export const postRecommend = catchAsync(async (req, res) => {
  if (!req.body || typeof req.body !== "object")
    throw badRequest("Request body is required");
  const results = await recommendService.getRecommendations(req.body);
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
  return sendSuccess(res, result, { message: "ML comparison complete" });
});
