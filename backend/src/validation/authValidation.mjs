import { checkSchema } from "express-validator";
import { checkPassword } from "./userValidation.mjs";

export const forgetPasswordValidation = checkSchema({
  email: {
    in: ["body"],
    trim: true,
    notEmpty: { errorMessage: "Should not be Empty" },
    matches: {
      options: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
      errorMessage: "please enter validate email",
    },
  },
});

export const verificationEmailValidation = checkSchema({
  email: {
    in: ["body"],
    trim: true,
    notEmpty: { errorMessage: "Should not be Empty" },
    isEmail: { errorMessage: "Please enter a valid email" },
  },
});

export const accountVerificationValidation = checkSchema({
  email: {
    in: ["body"],
    trim: true,
    notEmpty: { errorMessage: "Should not be Empty" },
    isEmail: { errorMessage: "Please enter a valid email" },
  },
  otp: {
    in: ["body"],
    trim: true,
    isLength: {
      options: { min: 6, max: 6 },
      errorMessage: "OTP must be 6 digits",
    },
    isNumeric: { errorMessage: "OTP must contain only digits" },
  },
});

export const changePasswordValidation = checkSchema({
  password: checkPassword,
  confirmPassword: {
    ...checkPassword,
    custom: {
      options: (value, { req }) => {
        return value === req.body.password;
      },
      errorMessage: "password did not matched",
    },
  },
});

// ---- Login ----
//
// `roleName` is required on the login body but is **not** whitelisted
// here. The login validator is open-string on purpose: admins must be
// able to log in without maintaining a separate login whitelist, and
// the DB row is the source of truth. `assertUserRoleMatches` (in
// `services/rbacService.mjs`) is what actually compares the FE's
// `roleName` against the user's stored role — it is wired up in a
// later step (the `roleGuard` middleware on the login route).
//
// Keeping the login validator open-string also means a typo or wrong
// role from the FE surfaces as a 303 (handled by `roleGuard`), not a
// 400 from this schema. The 400 from this schema only fires for
// missing or non-string `roleName`.
export const loginSchema = checkSchema({
  email: {
    in: ["body"],
    trim: true,
    notEmpty: { errorMessage: "Should not be Empty" },
    matches: {
      options: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
      errorMessage: "please enter validate email",
    },
  },
  password: {
    in: ["body"],
    notEmpty: { errorMessage: "password is required" },
  },
  roleName: {
    in: ["body"],
    trim: true,
    notEmpty: { errorMessage: "roleName is required" },
  },
});
