import { Router } from "express";
import { mockUsers } from "../mockData/userData.mjs";
import "../stratagies/userStrategy.mjs";
import passport from "passport";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import {
  isAuthenticate,
  validationWith,
} from "../middleware/userMiddleware.mjs";
import {
  forgetPasswordController,
  registerUserController,
  userLoginController,
} from "../controller/authController.mjs";
import {
  checkPassword,
  userCreationValidation,
} from "../validation/userValidation.mjs";
import { prisma } from "../config/index.mjs";
import { generateOtp } from "../middleware/authOtp.mjs";
import { checkSchema } from "express-validator";
import {
  registerUserService,
  resendOtpService,
  userLogoutService,
  verifyEmail,
  verifyOtpService,
  verifyPassword,
} from "../service/authService.mjs";

export const authRoutes = Router();

authRoutes.post("/login", userLoginController);

authRoutes.post("/logout", isAuthenticate, userLogoutService);

authRoutes.post("/register", registerUserController);
// authRoutes.get(
//   "/verify/:email",
//   asyncHandler(async (req, res) => {
//     const { email } = req.params;

//     const user = await prisma.users.findUnique({
//       where: { email: email },
//     });
//     const otp = await prisma.otp.findFirst({
//       where: { userId: user.userId },
//       select: { code },
//     });

//     res.send(otp);
//   }),
// );

// authRoutes.post(
//   "/verify",
//   asyncHandler(async (req, res) => {
//     const { otp, email } = req.body;
//     const findUser = await prisma.users.findUnique({
//       where: { email: email },
//       select: {
//         otps: {
//           select: { code, isUsed },
//         },
//       },
//     });

//     if (findUser.code !== otp) {
//       const error = new Error("Otp does not matched");
//       error.status(404);
//       throw error;
//     }
//     // if(findUser.otps.isUsed==true){

//     // }
//     await prisma.users.update({
//       where: { email: email },
//       data: {
//         isVerified: true,
//       },
//     });

//     return res.json({ message: "Verification complete" });
//     // await prisma.otp.update({
//     //   where: {
//     //     userId: findUser.userId,
//     //   },
//     //   data: {
//     //     isUsed: true,
//     //   },
//     // });
//   }),
// );

// authRoutes.get(
//   "/verify/:email",
//   asyncHandler(async (req, res) => {
//     const { email } = req.params;

//     const user = await prisma.users.findUnique({
//       where: { email: email },
//     });

//     if (!user) {
//       return res.status(404).json({ message: "User not found" });
//     }

//     const otp = await prisma.otp.findFirst({
//       where: {
//         userId: user.userId,
//         isUsed: false,
//         expiresAt: { gt: new Date() },
//       },
//       select: {
//         code: true,
//       },
//       orderBy: {
//         createdAt: "desc",
//       },
//     });

//     if (!otp) {
//       return res
//         .status(400)
//         .json({ message: "No active OTP found for this user" });
//     }

//     res.send(otp);
//   }),
// );

//verify
authRoutes.post("/verify", verifyEmail);

//resend otp
authRoutes.post("/resend", resendOtpService);

//forget password
authRoutes.post("/forget", forgetPasswordController);
authRoutes.post(
  "/forget/changePassword",
  validationWith(
    checkSchema({
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
    }),
  ),
  verifyPassword,
);
