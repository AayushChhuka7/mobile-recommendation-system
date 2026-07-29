import { prisma } from "../config/prisma.mjs";
import { generateOtp, hashPassword, verifyPassword } from "../utils/crypto.mjs";
import { sendEmail } from "../utils/email.mjs";
import { findRoleByName } from "./rbacService.mjs";
<<<<<<< HEAD
=======
import {
  PERSONA_TO_USAGE_TYPE,
  deriveCameraPreference,
  deriveBudgetSegment,
  ALLOWED_PERSONAS,
} from "./profileService.mjs";
>>>>>>> proxy-dev

import {
  notFound,
  badRequest,
  unauthorized,
  internal,
} from "../utils/ApiError.mjs";

const OTP_TTL_MS = 5 * 60 * 1000;

const newOtpExpiry = () => new Date(Date.now() + OTP_TTL_MS);

// authService — registration, OTP, login/logout, password/email change.
//
// Error policy (Phase 2): explicit "this should not exist" /
// "precondition failed" cases throw a typed factory from
// `utils/ApiError.mjs`. Raw Prisma errors (P2002, P2025, P2003)
// bubble up unhandled and are mapped centrally in the errorHandler.
//
// Status choices that differ from the pre-Phase-2 code:
//   - "Current password is incorrect"  403 → 401 AUTH_INVALID_CREDENTIALS
//     (403 means authenticated-but-forbidden; a failed credential check
//      on an authenticated user is a credential failure, not a permission
//      failure — the message is unchanged so FE toast text doesn't move.)
//
// Codes that share a category use `details.reason` to disambiguate
// per the locked-in Phase 1 design.

export const registerUserService = async (userData) => {
<<<<<<< HEAD
  const { confirmPassword, roleName, ...data } = userData;
=======
  const {
    confirmPassword,
    roleName,
    // Issue 2 — onboarding answers collected BEFORE the OTP step.
    // All optional. When omitted the user is created with no profile,
    // matching the pre-fix behaviour exactly.
    persona,
    budgetMin,
    budgetMax,
    preferredBrands,
    weights,
    ...data
  } = userData;
>>>>>>> proxy-dev

  const role = await findRoleByName(roleName);
  if (!role) {
    // Environment misconfiguration: the requested role isn't in the
    // seed data. This is a server-side problem, not a client one.
    throw internal("Service not initialized. Contact support.");
  }

  const code = generateOtp();

<<<<<<< HEAD
=======
  // ---- Normalise onboarding payload --------------------------------------
  // The persona + budget shape mirrors what `saveExplicitPreferences`
  // expects. We re-derive the same enums (usageType, cameraPreference,
  // budgetSegment) here so the same row shape lands in the DB whether
  // the user filled the onboarding step or only ever used the
  // "Recommend Me" modal after login.
  const validPersona =
    typeof persona === "string" && ALLOWED_PERSONAS.has(persona) ? persona : null;

  const maxBudgetRaw = budgetMax;
  const maxBudget =
    Number.isFinite(Number(maxBudgetRaw)) && Number(maxBudgetRaw) > 0
      ? Number(maxBudgetRaw)
      : null;
  const minBudgetRaw = budgetMin;
  const minBudget =
    Number.isFinite(Number(minBudgetRaw)) && Number(minBudgetRaw) >= 0
      ? Number(minBudgetRaw)
      : null;

  const usageType = validPersona
    ? PERSONA_TO_USAGE_TYPE[validPersona] || "Casual"
    : null;
  const cameraPreference = deriveCameraPreference(weights);
  const budgetSegment = maxBudget != null ? deriveBudgetSegment(maxBudget) : null;

  // Whitelist the brands array down to non-empty strings. We accept
  // anything the FE sends and let the DB column (JSON-shaped) hold it.
  const cleanedBrands = Array.isArray(preferredBrands)
    ? preferredBrands
        .filter((b) => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim().slice(0, 60))
        .slice(0, 20)
    : null;

  const hasOnboarding =
    validPersona != null ||
    maxBudget != null ||
    (Array.isArray(cleanedBrands) && cleanedBrands.length > 0) ||
    (weights && typeof weights === "object");

>>>>>>> proxy-dev
  const newUser = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.users.create({
      data: { ...data, roleId: role.roleId },
    });

    await tx.otp.create({
      data: {
        code,
        userId: createdUser.userId,
        purpose: "Registration",
        expiresAt: newOtpExpiry(),
      },
    });

<<<<<<< HEAD
=======
    // Issue 2 — write the onboarding answers into UserPreference +
    // CustomerProfile inside the SAME transaction as the user create.
    // This is what `saveExplicitPreferences` does for the post-login
    // "Recommend Me" modal — we replicate that two-upsert here so
    // the onboarding flow does not need a separate authenticated
    // round-trip.
    if (hasOnboarding) {
      await tx.userPreference.upsert({
        where: { userId: createdUser.userId },
        create: {
          userId: createdUser.userId,
          maxBudget: maxBudget ?? 0,
          cameraPreference,
          usageType: usageType || "Casual",
          ...(cleanedBrands && cleanedBrands.length > 0
            ? { preferredBrands: cleanedBrands }
            : {}),
        },
        update: {
          ...(maxBudget != null ? { maxBudget } : {}),
          cameraPreference,
          ...(usageType ? { usageType } : {}),
          ...(cleanedBrands && cleanedBrands.length > 0
            ? { preferredBrands: cleanedBrands }
            : {}),
        },
      });

      await tx.customerProfile.upsert({
        where: { userId: createdUser.userId },
        create: {
          userId: createdUser.userId,
          ...(budgetSegment ? { budgetSegment } : {}),
          ...(validPersona ? { recommendationPersona: validPersona } : {}),
          ...(cameraPreference ? { cameraPreference } : {}),
          ...(maxBudget != null ? { avgBudget: maxBudget } : {}),
          segmentConfidence: "confirmed",
        },
        update: {
          ...(budgetSegment ? { budgetSegment } : {}),
          ...(validPersona ? { recommendationPersona: validPersona } : {}),
          ...(cameraPreference ? { cameraPreference } : {}),
        },
      });
    }

>>>>>>> proxy-dev
    return createdUser;
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
    throw notFound("User not found");
  }
  if (user.isVerified === true) {
    // State precondition: client asked to verify an already-verified
    // account. Same category as "no pending email change" below;
    // discriminated by `details.reason` for the FE.
    throw badRequest("User is already verified, please log in", {
      reason: "already_verified",
    });
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
  if (!req.user) {
    throw unauthorized("Authentication required");
  }

  return {
    id: req.user.userId,
    email: req.user.email,
  };
};

export const userLogoutService = (req) => {
  return new Promise((resolve, reject) => {
    req.logout((err) => {
      if (err) return reject(err);
      req.session.destroy((sessionErr) => {
        if (sessionErr) {
          // Session-store failure on logout is a server problem.
          // `throw` inside a non-async callback wouldn't reject the
          // promise, so we propagate via reject().
          return reject(internal("Could not log out completely"));
        }
        resolve();
      });
    });
  });
};

export const forgetPasswordService = async (email) => {
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    throw notFound("User not found. Please Register");
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
    throw notFound("User not found");
  }

  const valid = await verifyPassword(currentPasswordRaw, user.password);
  if (!valid) {
    // 403 → 401: a wrong password is a credential failure, not a
    // permission failure. Message unchanged so FE toast text is stable.
    throw unauthorized("Current password is incorrect");
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
    throw notFound("User not found");
  }

  const valid = await verifyPassword(currentPasswordRaw, user.password);
  if (!valid) {
    throw unauthorized("Current password is incorrect");
  }

  if (user.email === newEmail) {
    throw badRequest("New email must be different from current email", {
      reason: "same_email",
    });
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
    throw badRequest("No pending email change request", {
      reason: "no_pending_email_change",
    });
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
