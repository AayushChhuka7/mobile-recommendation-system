import { prisma } from "../config/index.mjs";
import { generateOtp } from "../middleware/authOtp.mjs";
import { sendEmail } from "../middleware/emailSend.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { hashedPassword } from "../middleware/userMiddleware.mjs";

export const registerUserService = asyncHandler(async (req, res, next) => {
  const { confirmPassword, ...userData } = req.data;
  const newUser = await prisma.users.create({
    data: userData,
  });
  // const otp = generateOtp();
  const code = generateOtp();
  const otp = await prisma.otp.create({
    data: {
      code: code,
      userId: newUser.userId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  await sendEmail(userData.email, code);
  req.session.pendingUserId = newUser.userId;
  res.status(201).json({
    message: "Registration successful. Please verify your OTP.",
    userId: newUser.userId,
  });
});

// export const verifyOtpService = asyncHandler(async (req, res, next) => {
//   const otp = String(req.body.otp).trim();
//   let userId;
//   if (req.session.pendingUserId) {
//     userId = req.session.pendingUserId;
//   } else if (req.session.forgetUserId) {
//     userId = req.session.forgetUserId;
//   } else {
//     res.status(500);
//     throw new Error("Internal server Error");
//   }
//   console.log("looking for otp:", JSON.stringify(otp), "userId:", userId);
//   const validOtp = await prisma.otp.findFirst({
//     where: {
//       code: otp,
//       user: {
//         userId: userId,
//       },
//     },
//   });

//   req.session.validOtpId = validOtp.otpId;
//   if (!validOtp) {
//     res.status(400);
//     throw new Error("Invalid OTP code or email.");
//   }

//   if (validOtp.isUsed) {
//     res.status(400);
//     throw new Error("This OTP has already been used.");
//   }

//   if (new Date() > validOtp.expiresAt) {
//     res.status(400);
//     throw new Error("This OTP has expired.");
//   }
//   req.session.validOtpId = validOtp;
//   console.log(
//     "verify - sessionID:",
//     req.sessionID,
//     "pending:",
//     req.session.pendingUserId,
//     "forget:",
//     req.session.forgetUserId,
//   );
//   next();
// });

export const verifyOtpService = asyncHandler(async (req, res, next) => {
  const { otp } = req.body;
  let userId;
  if (req.session.pendingUserId) {
    userId = req.session.pendingUserId;
  } else if (req.session.forgetUserId) {
    userId = req.session.forgetUserId;
  } else {
    res.status(500);
    throw new Error("Internal server Error");
  }

  const validOtp = await prisma.otp.findFirst({
    where: {
      code: otp,
      user: { userId: userId },
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

  req.session.validOtpId = validOtp.otpId;
  next();
});

export const verifyEmail = [
  verifyOtpService,
  asyncHandler(async (req, res) => {
    let userId;
    if (req.session.pendingUserId) {
      userId = req.session.pendingUserId;
    }

    const otpId = req.session.validOtpId;
    await prisma.$transaction([
      prisma.users.update({
        where: { userId: userId },
        data: { isVerified: true },
      }),

      prisma.otp.update({
        where: { otpId: otpId },
        data: { isUsed: true },
      }),
    ]);
    if (req.session.pendingUserId) {
      delete req.session.pendingUserId;
      delete req.session.validOtpId;
    }
    return res.status(200).json({ message: "Verification complete" });
  }),
];

export const resendOtpService = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await prisma.users.findUnique({
    where: { email: email },
  });
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  const code = generateOtp();

  if (user.isVerified === true) {
    return res
      .status(404)
      .json({ message: "User is already verified please logged in" });
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
        code: code,
        userId: user.userId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    }),
  ]);

  await sendEmail(email, code);
  return res.status(200).json({
    message: "A new OTP has been sent successfully.",
  });
});

export const userLoginService = (req, res) => {
  console.log(req.session.passport.user);
  return res.status(200).json({
    message: "Login successful",
    user: {
      id: req.user.id,
      email: req.user.email,
    },
  });
};

export const userLogoutService = (req, res, next) => {
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
};
// export const forgetPasswordService = asyncHandler(async (req, res) => {
//   // console.log(email);
//   const email = req.data.email;
//   const user = await prisma.users.findUnique({
//     where: {
//       email: email,
//     },
//   });
//   if (!user) {
//     throw new Error("User not found .Please Register");
//   }
//   req.session.forgetUserId = user.userId;
//   const code = generateOtp();
//   await prisma.
//   await sendEmail(email, code);
//   console.log(req.session.forgetUserId);
//   console.log(
//     "forget - sessionID:",
//     req.sessionID,
//     "forgetUserId:",
//     req.session.forgetUserId,
//   );
//   res.send("verify the otp");
// });

export const forgetPasswordService = asyncHandler(async (req, res) => {
  const email = req.data.email;
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    throw new Error("User not found. Please Register");
  }

  req.session.forgetUserId = user.userId;

  const code = generateOtp();

  await prisma.$transaction([
    prisma.otp.updateMany({
      where: { userId: user.userId, isUsed: false },
      data: { isUsed: true },
    }),
    prisma.otp.create({
      data: {
        code,
        userId: user.userId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    }),
  ]);

  await sendEmail(email, code);
  console.log(req.session.forgetUserId);
  res.send("verify the otp");
});

export const verifyPassword = [
  verifyOtpService,
  asyncHandler(async (req, res) => {
    let userId;
    if (req.session.forgetUserId) {
      userId = req.session.forgetUserId;
    }
    const otpId = req.session.validOtpId;
    const password = req.data.password;
    await prisma.$transaction([
      prisma.users.update({
        where: { userId: userId },
        data: { password: password },
      }),

      prisma.otp.update({
        where: { otpId: otpId },
        data: { isUsed: true },
      }),
    ]);
    if (req.session.pendingUserId) {
      delete req.session.forgetUserId;
      delete req.session.validOtpId;
    }
    req.session.changeGranted = userId;
    return res.status(200).json({ message: "Verification complete" });
  }),
];
