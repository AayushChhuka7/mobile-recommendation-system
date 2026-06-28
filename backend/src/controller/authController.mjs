import {
  forgetPasswordService,
  registerUserService,
  requestEmailChangeService,
  resendOtpService,
  userLoginService,
  userLogoutService,
  verifyEmailChangeService,
  verifyEmailService,
  verifyPasswordChangeService,
} from "../services/authService.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";

export const registerUser = asyncHandler(async (req, res) => {
  const { userId } = await registerUserService(req.data);
  req.session.pendingUserId = userId;
  res.status(201).json({
    message: "Registration successful. Please verify your OTP.",
    userId,
  });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  await verifyEmailService(req);
  res.status(200).json({ message: "Verification complete" });
});

export const resendOtp = asyncHandler(async (req, res) => {
  await resendOtpService(req.body.email);
  res.status(200).json({ message: "A new OTP has been sent successfully." });
});

export const userLogin = (req, res) => {
  const user = userLoginService(req);
  res.status(200).json({ message: "Login successful", user });
};

export const userLogout = asyncHandler(async (req, res) => {
  await userLogoutService(req);
  res.clearCookie("connect.sid");
  res.status(200).json({ message: "Logged out successfully" });
});

export const forgetPassword = asyncHandler(async (req, res) => {
  const userId = await forgetPasswordService(req.data.email);
  req.session.forgetUserId = userId;
  res.send("verify the otp");
});

export const changePassword = asyncHandler(async (req, res) => {
  await verifyPasswordChangeService(req);
  res.status(200).json({ message: "Verification complete" });
});

export const requestEmailChange = asyncHandler(async (req, res) => {
  await requestEmailChangeService(
    req.user.userId,
    req.body.currentPassword,
    req.data.newEmail,
  );
  req.session.pendingEmail = req.data.newEmail;
  res.status(200).json({
    message: "OTP sent to new email. Please verify to complete the change.",
  });
});

export const verifyEmailChange = asyncHandler(async (req, res) => {
  await verifyEmailChangeService(req);
  res.status(200).json({ message: "Email changed successfully" });
});

// Tiny ack handler for forget-password OTP verification step.
// The frontend uses this to decide whether to show the change-password form.
export const ackOtpVerified = (req, res) => {
  res.status(200).json({ message: "OTP verified. You may now change your password." });
};
