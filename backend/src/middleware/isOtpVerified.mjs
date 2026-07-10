import { asyncHandler } from "./errorHandler.mjs";
import { findOtpById } from "../services/authService.mjs";
import { badRequest, otpInvalid } from "../utils/ApiError.mjs";

export const isOtpVerified = asyncHandler(async (req, res, next) => {
  const otpId = req.session.validOtpId;

  if (!otpId) {
    throw badRequest("OTP not verified");
  }

  const otp = await findOtpById(otpId);

  if (!otp || otp.isUsed || new Date() > otp.expiresAt) {
    delete req.session.validOtpId;
    throw otpInvalid("OTP expired or already used. Please verify again.");
  }

  next();
});
