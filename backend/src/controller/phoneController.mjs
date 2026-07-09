import * as phoneService from "../services/phoneService.mjs";
import {
  formatPhoneListItem,
  formatPhoneDetail,
} from "../serializers/phoneSerializer.mjs";
import { sendSuccess, sendPaginated } from "../utils/ApiResponse.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { badRequest } from "../utils/ApiError.mjs";

// GET /api/phones
export const getAllPhones = catchAsync(async (req, res) => {
  const { phones, pagination } = await phoneService.getAllPhones(req.query);

  return sendPaginated(res, phones.map(formatPhoneListItem), pagination);
});

// GET /api/phones/:id
export const getPhoneById = catchAsync(async (req, res) => {
  const { id } = req.params;

  if (!id || id.length < 10) {
    throw badRequest("Invalid phone ID");
  }

  const phone = await phoneService.getPhoneById(id);

  return sendSuccess(res, formatPhoneDetail(phone), {
    message: "Phone retrieved successfully",
  });
});

// Add these imports at the top

// Add these after getPhoneById

// GET /api/phones/search?q=iPhone
export const searchPhones = catchAsync(async (req, res) => {
  const searchTerm = req.query.q || req.query.search;

  if (!searchTerm) {
    throw badRequest("Search term is required. Use ?q= or ?search=");
  }

  const { phones, pagination } = await phoneService.searchPhones(req.query);

  return sendPaginated(res, phones.map(formatPhoneListItem), pagination);
});

// GET /api/phones/brand/:brandName
export const getPhonesByBrand = catchAsync(async (req, res) => {
  const { brandName } = req.params;
  const { brand, phones, pagination } = await phoneService.getPhonesByBrand(
    brandName,
    req.query,
  );

  return sendPaginated(
    res,
    phones.map(formatPhoneListItem),
    pagination,
    `Phones for brand '${brand.name}'`,
  );
});

// GET /api/phones/filters
export const getFilterOptions = catchAsync(async (req, res) => {
  const filters = await phoneService.getFilterOptions();
  return sendSuccess(res, filters);
});

// GET /api/phones/stats
export const getPhoneStats = catchAsync(async (req, res) => {
  const stats = await phoneService.getPhoneStats();
  return sendSuccess(res, stats);
});
