import { prisma } from "../config/prisma.mjs";
import { generateOtp, hashPassword, verifyPassword } from "../utils/crypto.mjs";
import { sendEmail } from "../utils/email.mjs";

const OTP_TTL_MS = 5 * 60 * 1000;

const newOtpExpiry = () => new Date(Date.now() + OTP_TTL_MS);

export const registerUserService = async (userData) => {
  const { confirmPassword, ...data } = userData;
  const newUser = await prisma.users.create({ data });

  const code = generateOtp();
  await prisma.otp.create({
    data: {
      code,
      userId: newUser.userId,
      purpose: "Registration",
      expiresAt: newOtpExpiry(),
    },
  });
  await sendEmail(data.email, code);

  return { userId: newUser.userId };
};

export const findValidOtp = async (code, userId, purpose) => {
  return prisma.otp.findFirst({
    where: {
      code,
      userId,
      purpose,
      isUsed: false,
      expiresAt: { gt: new Date() },
    },
  });
};

export const findOtpById = async (otpId) => {
  return prisma.otp.findUnique({ where: { otpId } });
};

export const verifyEmailService = async (req) => {
  const userId = req.session.pendingUserId;
  const otpId = req.session.validOtpId;

  await prisma.$transaction([
    prisma.users.update({
      where: { userId },
      data: { isVerified: true },
    }),
    prisma.otp.update({
      where: { otpId },
      data: { isUsed: true },
    }),
  ]);

  delete req.session.pendingUserId;
  delete req.session.validOtpId;
};

export const resendOtpService = async (email) => {
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }
  if (user.isVerified === true) {
    const error = new Error("User is already verified, please log in");
    error.status = 400;
    throw error;
  }

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
        purpose: "Registration",
        expiresAt: newOtpExpiry(),
      },
    }),
  ]);

  await sendEmail(email, code);
};

export const userLoginService = (req) => {
  return {
    id: req.user.id,
    email: req.user.email,
  };
};

export const userLogoutService = (req) => {
  return new Promise((resolve, reject) => {
    req.logout((err) => {
      if (err) return reject(err);
      req.session.destroy((sessionErr) => {
        if (sessionErr) {
          const error = new Error("Could not log out completely");
          error.status = 500;
          return reject(error);
        }
        resolve();
      });
    });
  });
};

export const forgetPasswordService = async (email) => {
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    const error = new Error("User not found. Please Register");
    error.status = 404;
    throw error;
  }

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
        purpose: "PasswordReset",
        expiresAt: newOtpExpiry(),
      },
    }),
  ]);

  await sendEmail(email, code);
  return user.userId;
};

export const verifyPasswordChangeService = async (req) => {
  const userId = req.session.forgetUserId;
  const otpId = req.session.validOtpId;
  const password = req.data.password;

  await prisma.$transaction([
    prisma.users.update({
      where: { userId },
      data: { password },
    }),
    prisma.otp.update({
      where: { otpId },
      data: { isUsed: true },
    }),
  ]);

  delete req.session.forgetUserId;
  delete req.session.validOtpId;
  return userId;
};

// ---- Self-service password / email change ----

export const changePasswordWhileLoggedInService = async (
  userId,
  currentPasswordRaw,
  newHashedPassword,
) => {
  const user = await prisma.users.findUnique({ where: { userId } });
  if (!user) {
    const error = new Error("User Not Found");
    error.status = 404;
    throw error;
  }

  const valid = await verifyPassword(currentPasswordRaw, user.password);
  if (!valid) {
    const error = new Error("Current password is incorrect");
    error.status = 403;
    throw error;
  }

  await prisma.users.update({
    where: { userId },
    data: { password: newHashedPassword },
  });
};

export const requestEmailChangeService = async (
  userId,
  currentPasswordRaw,
  newEmail,
) => {
  const user = await prisma.users.findUnique({ where: { userId } });
  if (!user) {
    const error = new Error("User Not Found");
    error.status = 404;
    throw error;
  }

  const valid = await verifyPassword(currentPasswordRaw, user.password);
  if (!valid) {
    const error = new Error("Current password is incorrect");
    error.status = 403;
    throw error;
  }

  if (user.email === newEmail) {
    const error = new Error("New email must be different from current email");
    error.status = 400;
    throw error;
  }

  const code = generateOtp();
  await prisma.$transaction([
    prisma.otp.updateMany({
      where: { userId, isUsed: false },
      data: { isUsed: true },
    }),
    prisma.otp.create({
      data: {
        code,
        userId,
        purpose: "EmailChange",
        expiresAt: newOtpExpiry(),
      },
    }),
  ]);

  await sendEmail(newEmail, code);
};

export const verifyEmailChangeService = async (req) => {
  const userId = req.user.userId;
  const otpId = req.session.validOtpId;
  const newEmail = req.session.pendingEmail;

  if (!newEmail) {
    const error = new Error("No pending email change request");
    error.status = 400;
    throw error;
  }

  await prisma.$transaction([
    prisma.users.update({
      where: { userId },
      data: { email: newEmail },
    }),
    prisma.otp.update({
      where: { otpId },
      data: { isUsed: true },
    }),
  ]);

  delete req.session.pendingEmail;
  delete req.session.validOtpId;
};
