import { Router } from "express";
import "../strategies/userStrategy.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserContext } from "../middleware/loadUserContext.mjs";
import { validationWith } from "../middleware/validator.mjs";
import { roleGuard } from "../middleware/roleGuard.mjs";
import {
  changePasswordValidation,
  forgetPasswordValidation,
  loginSchema,
} from "../validation/authValidation.mjs";
import {
  userCreationValidation,
  requestEmailChangeValidation,
} from "../validation/userValidation.mjs";
import { verifyOtp } from "../middleware/verifyOtp.mjs";
import { verifyOwnOtp } from "../middleware/verifyOwnOtp.mjs";
import { isOtpVerified } from "../middleware/isOtpVerified.mjs";
import {
  ackOtpVerified,
  changePassword,
  forgetPassword,
  getRoleOptions,
  registerUser,
  requestEmailChange,
  resendOtp,
  userLogin,
  userLogout,
  verifyEmail,
  verifyEmailChange,
} from "../controller/authController.mjs";

export const authRoutes = Router();


authRoutes.get("/role-options", getRoleOptions);

authRoutes.post(
  "/login",
  validationWith(loginSchema, ["email", "password", "roleName"]),
  roleGuard,
  userLogin,
);
authRoutes.post("/logout", isAuthenticate, userLogout);
authRoutes.post(
  "/register",
  validationWith(
    userCreationValidation,
    [
      "name",
      "email",
      "password",
      "confirmPassword",
      "phoneNo",
      "roleName",
      // Issue 2 — onboarding fields forwarded in the same POST body so
      // the user + OTP + preferences land in one atomic transaction.
      "persona",
      "budgetMin",
      "budgetMax",
      "preferredBrands",
      "weights",
    ],
  ),
  registerUser,
);
authRoutes.post("/verify", verifyOtp, verifyEmail);
authRoutes.post("/resend", resendOtp);

//forget hunda email rakhera send haney
authRoutes.post(
  "/forget",
  validationWith(forgetPasswordValidation, ["email"]),
  forgetPassword,
);

//otp verify garney after forget password 
authRoutes.post("/forget/verify", verifyOtp, ackOtpVerified);


authRoutes.post(
  "/forget/changePassword",
  isOtpVerified,
  validationWith(changePasswordValidation, ["password", "confirmPassword"]),
  changePassword,
);

authRoutes.post(
  "/me/email/request",
  isAuthenticate,
  loadUserContext,
  validationWith(requestEmailChangeValidation, ["currentPassword", "newEmail"]),
  requestEmailChange,
);
authRoutes.post(
  "/me/email/verify",
  isAuthenticate,
  loadUserContext,
  verifyOwnOtp,
  verifyEmailChange,
);
