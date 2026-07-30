import * as phoneService from "../services/phoneService.mjs";
import {
  safeRecordSearchEvent,
} from "../services/profileService.mjs";
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

  // Implicit signal: log the search query / filter snapshot into
  // SearchHistory. Fire-and-forget so analytics never breaks the
  // listing response.
  if (req.user && req.user.userId) {
    const q = req.query;
    const searchTerm =
      typeof q.search === "string" && q.search.trim().length > 0
        ? q.search.trim()
        : null;
    const filterKeys = [
      "brand",
      "minPrice",
      "maxPrice",
      "minRam",
      "minBattery",
      "os",
      "has5G",
      "hasNfc",
      "hasOis",
    ];
    const filtersSnapshot = {};
    for (const k of filterKeys) {
      if (q[k] !== undefined && q[k] !== "") filtersSnapshot[k] = q[k];
    }
    if (searchTerm || Object.keys(filtersSnapshot).length > 0) {
      safeRecordSearchEvent(req.user.userId, {
        searchQuery: searchTerm,
        filtersJson: filtersSnapshot,
      });
    }
  }

  return sendPaginated(res, phones.map(formatPhoneListItem), pagination);
});

// GET /api/phones/:id
export const getPhoneById = catchAsync(async (req, res) => {
  const { id } = req.params;

  if (!id || id.length < 10) {
    throw badRequest("Invalid phone ID");
  }

  const phone = await phoneService.getPhoneById(id);

  // Implicit signal: the unified "view" event is fired by the FE via
  // `useEventLogger("view", { phoneId: id })` (see PhoneDetail.jsx),
  // which lands in the `Event` table + per-tag `BehaviorScore` upserts
  // through behaviorAnalyzer.recordEvent. Step D (5-signal fusion)
  // reads BehaviorScore for the 0.1053 search_history weight.
  //
  // Previously this handler ALSO called `safeRecordBrowseEvent`, which
  // wrote a `BrowsingHistory` row AND re-fired the same view through
  // `safeRecordBehaviorEvent` — producing 4-6+ history rows per click
  // (and even more under React 18 StrictMode's dev-mode double-mount).
  // Removed so the FE is the single source of truth for view tracking.

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

// POST /api/phones/compare
export const comparePhones = catchAsync(async (req, res) => {
  const { phoneIds } = req.body;

  if (!phoneIds || !Array.isArray(phoneIds)) {
    throw badRequest("phoneIds must be an array of phone IDs");
  }

  const phones = await phoneService.comparePhones(phoneIds);

  return sendSuccess(res, phones.map(formatPhoneDetail), {
    message: "Phones compared successfully",
  });
});

// GET /api/phones/featured
export const getFeaturedPhones = catchAsync(async (req, res) => {
  const phones = await phoneService.getFeaturedPhones();
  return sendSuccess(res, phones.map(formatPhoneListItem));
});

// GET /api/phones/latest
export const getLatestPhones = catchAsync(async (req, res) => {
  const phones = await phoneService.getLatestPhones();
  return sendSuccess(res, phones.map(formatPhoneListItem));
});

// GET /api/phones/best-value
export const getBestValuePhones = catchAsync(async (req, res) => {
  const phones = await phoneService.getBestValuePhones();
  return sendSuccess(res, phones.map(formatPhoneListItem));
});
