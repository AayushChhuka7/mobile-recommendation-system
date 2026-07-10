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
import { getAssignableRoles } from "../services/rbacService.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { sendSuccess } from "../utils/ApiResponse.mjs";

export const registerUser = asyncHandler(async (req, res) => {
  const { userId } = await registerUserService(req.data);

  //verify garna baki bhayeko user ko id
  req.session.pendingUserId = userId;
  return sendSuccess(
    res,
    { userId },
    {
      status: 201,
      message: "Registration successful. Please verify your OTP.",
    },
  );
});

export const verifyEmail = asyncHandler(async (req, res) => {
  await verifyEmailService(req);
  return sendSuccess(res, null, { message: "Verification complete" });
});

export const resendOtp = asyncHandler(async (req, res) => {
  await resendOtpService(req.body.email);
  return sendSuccess(res, null, {
    message: "A new OTP has been sent successfully.",
  });
});

export const userLogin = asyncHandler(async (req, res) => {
  const user = await userLoginService(req);
  return sendSuccess(res, { user }, { message: "Login successful" });
});

export const userLogout = asyncHandler(async (req, res) => {
  await userLogoutService(req);
  res.clearCookie("connect.sid");
  return sendSuccess(res, null, { message: "Logged out successfully" });
});

export const forgetPassword = asyncHandler(async (req, res) => {
  const userId = await forgetPasswordService(req.data.email);
  req.session.forgetUserId = userId;
  // Plain-text → standardized envelope. Frontend parses `code` to
  // decide the next step (show OTP form, then call POST /auth/forget/verify).
  return sendSuccess(
    res,
    { userId },
    {
      message: "OTP sent. Please verify to continue password reset.",
    },
  );
});

export const changePassword = asyncHandler(async (req, res) => {
  await verifyPasswordChangeService(req);
  return sendSuccess(res, null, { message: "Verification complete" });
});

export const requestEmailChange = asyncHandler(async (req, res) => {
  await requestEmailChangeService(
    req.user.userId,
    req.body.currentPassword,
    req.data.newEmail,
  );
  req.session.pendingEmail = req.data.newEmail;
  return sendSuccess(res, null, {
    message: "OTP sent to new email. Please verify to complete the change.",
  });
});

export const verifyEmailChange = asyncHandler(async (req, res) => {
  await verifyEmailChangeService(req);
  return sendSuccess(res, null, { message: "Email changed successfully" });
});

// Tiny ack handler for forget-password OTP verification step.
// The frontend uses this to decide whether to show the change-password form.
export const ackOtpVerified = (req, res) => {
  return sendSuccess(res, null, {
    message: "OTP verified. You may now change your password.",
  });
};

// Returns the whitelist of roles a user can self-assign at
// registration. The FE's `/choose-role` screen renders this list;
// `Admin` is intentionally excluded (admin-only assignment). The
// whitelist lives in `services/rbacService.mjs` as the single
// source of truth, so this handler has no business logic of its own.
export const getRoleOptions = asyncHandler(async (req, res) => {
  const roles = getAssignableRoles();
  return sendSuccess(res, { roles });
});
