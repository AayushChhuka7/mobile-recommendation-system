import { asyncHandler } from "./errorHandler.mjs";
import { findValidOtp } from "../services/authService.mjs";

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
    return res.status(500).json({ message: "Internal server Error" });
  }

  const validOtp = await findValidOtp(otp, userId, purpose);
  if (!validOtp) {
    return res.status(400).json({ message: "Invalid OTP code or email." });
  }
  if (validOtp.isUsed) {
    return res.status(400).json({ message: "This OTP has already been used." });
  }
  if (new Date() > validOtp.expiresAt) {
    return res.status(400).json({ message: "This OTP has expired." });
  }

  req.session.validOtpId = validOtp.otpId;
  next();
});
