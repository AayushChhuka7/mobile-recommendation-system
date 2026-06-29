import {
  assignRole,
  createUser,
  deactivateOwnAccount as deactivateOwnAccountService,
  deleteUser as deleteUserService,
  findAllUsers,
  revokeRole,
  updateUser,
} from "../services/userService.mjs";
import { changePasswordWhileLoggedInService } from "../services/authService.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";

export const getAllUser = asyncHandler(async (req, res) => {
  const users = await findAllUsers();
  if (users.length === 0) {
    throw new Error("No users found");
  }
  res.status(200).json(users);
});

export const getUserById = (req, res) => {
  res.status(200).json(req.checkUser);
};

export const postUser = asyncHandler(async (req, res) => {
  const newUser = await createUser(req.data);
  res.status(201).json(newUser);
});

export const patchUser = asyncHandler(async (req, res) => {
  const updatedUser = await updateUser(req.checkUser.userId, req.data);
  res.status(200).json({
    message: "User updated successfully",
    user: updatedUser,
  });
});

export const deleteUser = asyncHandler(async (req, res) => {
  await deleteUserService(req.checkUser.userId);
  res.status(200).json({ message: "Deletion Complete" });
});

// ---- Self-service profile endpoints ----

export const getOwnProfile = (req, res) => {
  const { userId, name, email, phoneNo, isActive, isVerified } = req.user;
  res.status(200).json({
    userId,
    name,
    email,
    phoneNo,
    isActive,
    isVerified,
  });
};

export const updateOwnProfile = asyncHandler(async (req, res) => {
  const updatedUser = await updateUser(req.user.userId, req.data);
  const { userId, name, email, phoneNo, isActive, isVerified } = updatedUser;
  res.status(200).json({
    message: "Profile updated successfully",
    user: { userId, name, email, phoneNo, isActive, isVerified },
  });
});

export const changeOwnPassword = asyncHandler(async (req, res) => {
  await changePasswordWhileLoggedInService(
    req.user.userId,
    req.body.currentPassword,
    req.data.password,
  );
  res.status(200).json({ message: "Password changed successfully" });
});

export const deactivateOwnAccount = asyncHandler(async (req, res) => {
  await deactivateOwnAccountService(req.user.userId);
  await new Promise((resolve, reject) => {
    req.logout((err) => {
      if (err) return reject(err);
      req.session.destroy((sessionErr) => {
        if (sessionErr) return reject(sessionErr);
        resolve();
      });
    });
  });
  res.clearCookie("connect.sid");
  res.status(200).json({ message: "Account deactivated successfully" });
});

// ---- RBAC Phase 1 — admin-only role assignment ----

export const assignUserRole = asyncHandler(async (req, res) => {
  const updated = await assignRole(req.checkUser.userId, req.data.roleName);
  // Beginner-friendly if/else instead of `??` (nullish coalescing).
  let roleLabel = null;
  if (updated.role && updated.role.roleName) {
    roleLabel = updated.role.roleName;
  }
  res.status(200).json({
    message: `Role "${req.data.roleName}" assigned to user ${updated.userId}`,
    user: {
      userId: updated.userId,
      email: updated.email,
      role: roleLabel,
    },
  });
});

export const revokeUserRole = asyncHandler(async (req, res) => {
  const updated = await revokeRole(req.checkUser.userId);
  // Beginner-friendly if/else instead of `??` (nullish coalescing).
  let roleLabel = null;
  if (updated.role && updated.role.roleName) {
    roleLabel = updated.role.roleName;
  }
  res.status(200).json({
    message: `Role revoked for user ${updated.userId}`,
    user: {
      userId: updated.userId,
      email: updated.email,
      role: roleLabel,
    },
  });
});