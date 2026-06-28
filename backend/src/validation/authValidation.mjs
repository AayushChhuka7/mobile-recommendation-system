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
