import {
  createUser,
  deactivateOwnAccount as deactivateOwnAccountService,
  deleteUser as deleteUserService,
  findAllUsers,
  updateUser,
} from "../services/userService.mjs";
import { assignRole, revokeRole } from "../services/rbacService.mjs";
import { changePasswordWhileLoggedInService } from "../services/authService.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { sendSuccess } from "../utils/ApiResponse.mjs";
import { notFound } from "../utils/ApiError.mjs";

export const getAllUser = asyncHandler(async (req, res) => {
  const users = await findAllUsers();
  if (users.length === 0) {
    // Empty list → empty data array, not a 404. The locked-in Phase 1
    // design: out-of-range page = empty data, not a not-found error.
    throw notFound("No users found");
  }
<<<<<<< HEAD
  return sendSuccess(res, users);
=======
  // Flatten the role relation to a plain string so the FE doesn't have
  // to dig through `{ role: { roleName: "Admin" } }`. `userService`
  // returns the relation; we project it here.
  const flattened = users.map((u) => ({
    userId: u.userId,
    name: u.name,
    email: u.email,
    phoneNo: u.phoneNo,
    isActive: u.isActive,
    isVerified: u.isVerified,
    role: u.role && u.role.roleName ? u.role.roleName : null,
  }));
  return sendSuccess(res, flattened);
>>>>>>> proxy-dev
});

export const getUserById = asyncHandler(async (req, res) => {
  return sendSuccess(res, req.checkUser);
});

export const postUser = asyncHandler(async (req, res) => {
  const newUser = await createUser(req.data);
  return sendSuccess(res, newUser, {
    status: 201,
    message: "User created successfully",
  });
});

export const patchUser = asyncHandler(async (req, res) => {
  const updatedUser = await updateUser(req.checkUser.userId, req.data);
  return sendSuccess(res, { user: updatedUser }, {
    message: "User updated successfully",
  });
});

export const deleteUser = asyncHandler(async (req, res) => {
  await deleteUserService(req.checkUser.userId);
  return sendSuccess(res, null, { message: "Deletion Complete" });
});

// ---- Self-service profile endpoints ----

export const getOwnProfile = (req, res) => {
  const { userId, name, email, phoneNo, isActive, isVerified } = req.user;
<<<<<<< HEAD
  return sendSuccess(res, { userId, name, email, phoneNo, isActive, isVerified });
=======
  // `role` is sourced from `req.auth.roleNames` (loaded by
  // `loadUserContext` middleware from `findUserRoles`). The frontend
  // uses it for admin-only route guards and conditional nav.
  const role =
    req.auth && Array.isArray(req.auth.roleNames) && req.auth.roleNames[0]
      ? req.auth.roleNames[0]
      : null;
  return sendSuccess(res, {
    userId,
    name,
    email,
    phoneNo,
    isActive,
    isVerified,
    role,
  });
>>>>>>> proxy-dev
};

export const updateOwnProfile = asyncHandler(async (req, res) => {
  const updatedUser = await updateUser(req.user.userId, req.data);
  const { userId, name, email, phoneNo, isActive, isVerified } = updatedUser;
  return sendSuccess(
    res,
    { userId, name, email, phoneNo, isActive, isVerified },
    { message: "Profile updated successfully" },
  );
});

export const changeOwnPassword = asyncHandler(async (req, res) => {
  await changePasswordWhileLoggedInService(
    req.user.userId,
    req.body.currentPassword,
    req.data.password,
  );
  return sendSuccess(res, null, { message: "Password changed successfully" });
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
  return sendSuccess(res, null, { message: "Account deactivated successfully" });
});

// ---- RBAC Phase 1 — admin-only role assignment ----

export const assignUserRole = asyncHandler(async (req, res) => {
  const updated = await assignRole(req.checkUser.userId, req.data.roleName);
  // Beginner-friendly if/else instead of `??` (nullish coalescing).
  let roleLabel = null;
  if (updated.role && updated.role.roleName) {
    roleLabel = updated.role.roleName;
  }
  return sendSuccess(
    res,
    {
      userId: updated.userId,
      email: updated.email,
      role: roleLabel,
    },
    { message: `Role "${req.data.roleName}" assigned to user ${updated.userId}` },
  );
});

export const revokeUserRole = asyncHandler(async (req, res) => {
  const updated = await revokeRole(req.checkUser.userId);
  // Beginner-friendly if/else instead of `??` (nullish coalescing).
  let roleLabel = null;
  if (updated.role && updated.role.roleName) {
    roleLabel = updated.role.roleName;
  }
  return sendSuccess(
    res,
    {
      userId: updated.userId,
      email: updated.email,
      role: roleLabel,
    },
    { message: `Role revoked for user ${updated.userId}` },
  );
});
