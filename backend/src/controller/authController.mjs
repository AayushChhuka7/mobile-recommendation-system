import { asyncHandler } from "../middleware/errorHandler.mjs";
import { prisma } from "../config/index.mjs";
import { generateOtp } from "../middleware/authOtp.mjs";
import { sendEmail } from "../middleware/emailSend.mjs";
import { validationWith } from "../middleware/userMiddleware.mjs";
import { checkSchema } from "express-validator";
import {
  forgetPasswordService,
  registerUserService,
  userLoginService,
} from "../service/authService.mjs";

import { userCreationValidation } from "../validation/userValidation.mjs";
import passport from "passport";

export const registerUserController = [
  validationWith(userCreationValidation),
  registerUserService,
];

export const forgetPasswordController = [
  validationWith(
    checkSchema({
      email: {
        in: ["body"],
        trim: true,
        notEmpty: { errorMessage: "Should not be Empty" },
        matches: {
          options: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
          errorMessage: "please enter validate email",
        },
      },
    }),
    
  ),
  forgetPasswordService,
];

export const userLoginController = [
  passport.authenticate("local"),
  userLoginService,
];
