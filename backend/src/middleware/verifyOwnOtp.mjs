import { asyncHandler } from "./errorHandler.mjs";
import { findValidOtp } from "../services/authService.mjs";

export const verifyOwnOtp = asyncHandler(async (req, res, next) => {
  const { otp } = req.body;
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  // Defensive: if pendingEmail isn't set, the user didn't request an email change.
  if (!req.session.pendingEmail) {
    return res.status(400).json({ message: "No pending email change request" });
  }

  const validOtp = await findValidOtp(otp, userId, "EmailChange");
  if (!validOtp) {
    return res.status(400).json({ message: "Invalid OTP code." });
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
