import { Router } from "express";
import { mockUsers } from "../mockData/userData.mjs";
import "../stratagies/userStrategy.mjs";
import passport from "passport";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { validationWith } from "../middleware/userMiddleware.mjs";
import { registerUser } from "../controller/authController.mjs";
import { userCreationValidation } from "../validation/userValidation.mjs";
import { prisma } from "../config/index.mjs";
import { generateOtp } from "../middleware/authOtp.mjs";

export const authRoutes = Router();

authRoutes.post("/login", passport.authenticate("local"), (req, res) => {
  console.log(req.session.passport.user);
  return res.status(200).json({
    message: "Login successful",
    user: {
      id: req.user.id,
      email: req.user.email,
    },
  });
});

authRoutes.post("/logout", (req, res, next) => {
  // req.user hatako
  req.logout((err) => {
    if (err) {
      return next(err);
    }

    // Destroy session  in server
    req.session.destroy((sessionErr) => {
      if (sessionErr) {
        return res
          .status(500)
          .json({ message: "Could not log out completely" });
      }
      // browser ko cookie hatako
      res.clearCookie("connect.sid");
      return res.status(200).json({ message: "Logged out successfully" });
    });
  });
});

authRoutes.post(
  "/register",
  validationWith(userCreationValidation),
  registerUser,
);
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

authRoutes.get(
  "/verify/:email",
  asyncHandler(async (req, res) => {
    const { email } = req.params;

    const user = await prisma.users.findUnique({
      where: { email: email },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const otp = await prisma.otp.findFirst({
      where: {
        userId: user.userId,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
      select: {
        code: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!otp) {
      return res
        .status(400)
        .json({ message: "No active OTP found for this user" });
    }

    res.send(otp);
  }),
);

//verify
authRoutes.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const { otp, email } = req.body;

    const validOtp = await prisma.otp.findFirst({
      where: {
        code: otp,
        user: {
          email: email,
        },
      },
    });

    if (!validOtp) {
      res.status(400);
      throw new Error("Invalid OTP code or email.");
    }

    if (validOtp.isUsed) {
      res.status(400);
      throw new Error("This OTP has already been used.");
    }

    if (new Date() > validOtp.expiresAt) {
      res.status(400);
      throw new Error("This OTP has expired.");
    }

    await prisma.$transaction([
      prisma.users.update({
        where: { email: email },
        data: { isVerified: true },
      }),

      prisma.otp.update({
        where: { otpId: validOtp.otpId }, 
        data: { isUsed: true },
      }),
    ]);

    return res.status(200).json({ message: "Verification complete" });
  }),
);

//resend otp
authRoutes.post(
  "/resend/",
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await prisma.users.findUnique({
      where: { email: email },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    //2ota result dinxha euta count arko data (updateMany bata :count use gardainam so _)
    const [_, newOtp] = await prisma.$transaction([
      prisma.otp.updateMany({
        where: {
          userId: user.userId,
          isUsed: false,
        },
        data: {
          isUsed: true,
        },
      }),

      prisma.otp.create({
        data: {
          code: generateOtp(),
          userId: user.userId,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      }),
    ]);

    return res.status(200).json({
      message: "A new OTP has been sent successfully.",
      code: newOtp.code,
    });
  }),
);
