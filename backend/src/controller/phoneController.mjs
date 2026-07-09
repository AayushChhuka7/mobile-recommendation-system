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
