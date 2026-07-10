import { asyncHandler } from "./errorHandler.mjs";
import { findValidOtp } from "../services/authService.mjs";
import { internal, otpInvalid } from "../utils/ApiError.mjs";

export const verifyOtp = asyncHandler(async (req, res, next) => {
  const { otp } = req.body;
  let userId;
  let purpose;

  if (req.session.pendingUserId) {
    userId = req.session.pendingUserId;
    purpose = "Registration";
  } else if (req.session.forgetUserId) {
    userId = req.session.forgetUserId;
    purpose = "PasswordReset";
  } else {
    // Reached the OTP-verify step without a pending registration or
    // password-reset request in the session — server-side state error.
    throw internal("No pending registration or password-reset request in session");
  }

  const validOtp = await findValidOtp(otp, userId, purpose);
  if (!validOtp) {
    throw otpInvalid("Invalid OTP code or email.", { reason: "invalid" });
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
