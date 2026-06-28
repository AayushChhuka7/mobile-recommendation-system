import { Router } from "express";
import passport from "passport";
import "../strategies/userStrategy.mjs";
import { isAuthenticate } from "../middleware/auth.mjs";
import { validationWith } from "../middleware/validator.mjs";
import {
  changePasswordValidation,
  forgetPasswordValidation,
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
  registerUser,
  requestEmailChange,
  resendOtp,
  userLogin,
  userLogout,
  verifyEmail,
  verifyEmailChange,
} from "../controller/authController.mjs";

export const authRoutes = Router();

authRoutes.post("/login", passport.authenticate("local"), userLogin);
authRoutes.post("/logout", isAuthenticate, userLogout);
authRoutes.post(
  "/register",
  validationWith(
    userCreationValidation,
    ["name", "email", "password", "confirmPassword", "phoneNo"],
  ),
  registerUser,
);
authRoutes.post("/verify", verifyOtp, verifyEmail);
authRoutes.post("/resend", resendOtp);
authRoutes.post(
  "/forget",
  validationWith(forgetPasswordValidation, ["email"]),
  forgetPassword,
);

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
  validationWith(requestEmailChangeValidation, ["currentPassword", "newEmail"]),
  requestEmailChange,
);
authRoutes.post(
  "/me/email/verify",
  isAuthenticate,
  verifyOwnOtp,
  verifyEmailChange,
);
