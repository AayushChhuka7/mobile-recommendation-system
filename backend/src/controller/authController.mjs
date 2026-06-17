import { asyncHandler } from "../middleware/errorHandler.mjs";
import { prisma } from "../config/index.mjs";
import { generateOtp } from "../middleware/authOtp.mjs";

export const registerUser = asyncHandler(async (req, res, next) => {
  const data = req.data;
  const newUser = await prisma.users.create({
    data: data,
  });
  // const otp = generateOtp();
  const otp = await prisma.otp.create({
    data: {
      code: generateOtp(),
      userId: newUser.userId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  req.session.pendingUserId = newUser.userId;
  res.status(201).json({
    message: "Registration successful. Please verify your OTP.",
    userId: newUser.userId,
  });
});
