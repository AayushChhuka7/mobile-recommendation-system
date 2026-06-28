// Gate that ensures an OTP has been verified in this session AND is still
// fresh against the database. Re-checks expiresAt and isUsed so that
// the gap between /forget/verify and /forget/changePassword is bounded.

import { asyncHandler } from "./errorHandler.mjs";
import { findOtpById } from "../services/authService.mjs";

export const isOtpVerified = asyncHandler(async (req, res, next) => {
  const otpId = req.session.validOtpId;
  if (!otpId) {
    return res.status(400).json({ message: "OTP not verified" });
  }

  const otp = await findOtpById(otpId);
  if (!otp || otp.isUsed || new Date() > otp.expiresAt) {
    delete req.session.validOtpId;
    return res
      .status(400)
      .json({ message: "OTP expired or already used. Please verify again." });
  }

  next();
});
