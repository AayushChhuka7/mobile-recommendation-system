import { asyncHandler } from "./errorHandler.mjs";
import { findValidOtp } from "../services/authService.mjs";
import { unauthorized, badRequest, otpInvalid } from "../utils/ApiError.mjs";

export const verifyOwnOtp = asyncHandler(async (req, res, next) => {
  const { otp } = req.body;
  const userId = req.user?.userId;

  if (!userId) {
    throw unauthorized("Not authenticated");
  }

  // Defensive: if pendingEmail isn't set, the user didn't request an email change.
  if (!req.session.pendingEmail) {
    throw badRequest("No pending email change request", {
      reason: "no_pending_email_change",
    });
  }

  const validOtp = await findValidOtp(otp, userId, "EmailChange");
  if (!validOtp) {
    throw otpInvalid("Invalid OTP code.", { reason: "invalid" });
  }
  if (validOtp.isUsed) {
    throw otpInvalid("This OTP has already been used.", { reason: "used" });
  }
  if (new Date() > validOtp.expiresAt) {
    throw otpInvalid("This OTP has expired.", { reason: "expired" });
  }

  req.session.validOtpId = validOtp.otpId;
  next();
});
