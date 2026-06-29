import { prisma } from "../config/prisma.mjs";

export const findAllUsers = async () => {
  return prisma.users.findMany();
};

export const findUserById = async (id) => {
  const user = await prisma.users.findUnique({
    where: { userId: id },
  });
  if (!user) {
    const error = new Error("User Not Found");
    error.status = 400;
    throw error;
  }
  return user;
};

export const findUserByEmail = async (email) => {
  return prisma.users.findUnique({ where: { email } });
};

export const createUser = async (data) => {
  return prisma.users.create({ data });
};

export const updateUser = async (id, data) => {
  return prisma.users.update({
    where: { userId: id },
    data,
  });
};

export const deleteUser = async (id) => {
  return prisma.users.delete({ where: { userId: id } });
};

export const deactivateOwnAccount = async (userId) => {
  return prisma.users.update({
    where: { userId },
    data: { isActive: false },
  });
};

export const findActiveUserById = async (id) => {
  const user = await prisma.users.findUnique({ where: { userId: id } });
  if (!user) {
    const error = new Error("User Not Found");
    error.status = 404;
    throw error;
  }
  if (!user.isActive) {
    const error = new Error("Account is deactivated");
    error.status = 403;
    throw error;
  }
  return user;
};

// ---- RBAC Phase 1 — role helpers ----
//
// Roles live in the `roles` table; users have a single FK `roleId` on
// `Users`. Promotions are data writes (no schema change).

const SAFE_USER_FIELDS = {
  userId: true,
  name: true,
  email: true,
  phoneNo: true,
  isActive: true,
  isVerified: true,
  roleId: true,
};

const ROLES_SAFE_USER_FIELDS = {
  userId: true,
  name: true,
  email: true,
  phoneNo: true,
  isActive: true,
  isVerified: true,
  role: { select: { roleId: true, roleName: true } },
};

// Select used by deserializeUser — `password` and other sensitive
// fields are deliberately excluded. Use this on every code path that
// puts a user onto `req` / the session.
export const SAFE_USER_SELECT = SAFE_USER_FIELDS;

export const findRoleByName = async (roleName) => {
  return prisma.roles.findUnique({ where: { roleName } });
};

export const findUserRoles = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { userId },
    select: ROLES_SAFE_USER_FIELDS,
  });
  if (!user) return [];
  // Phase 1 = single role per user. Return an array shape so callers
  // don't have to special-case Phase 2 when it lands.
  // Beginner-friendly if/else instead of a ternary expression.
  if (user.role && user.role.roleName) {
    return [user.role.roleName];
  }
  return [];
};

// Replaces the user's current role. Uses a transaction so the new
// `roleId` is committed atomically.
export const assignRole = async (userId, roleName) => {
  const role = await findRoleByName(roleName);
  if (!role) {
    const error = new Error(`Role "${roleName}" does not exist`);
    error.status = 404;
    throw error;
  }

  const userExists = await prisma.users.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (!userExists) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  return prisma.users.update({
    where: { userId },
    data: { roleId: role.roleId },
    select: ROLES_SAFE_USER_FIELDS,
  });
};

// Removes the user's role by clearing the FK. Keeps the `roles` row
// itself untouched.
export const revokeRole = async (userId) => {
  const userExists = await prisma.users.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (!userExists) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }

  return prisma.users.update({
    where: { userId },
    data: { roleId: null },
    select: ROLES_SAFE_USER_FIELDS,
  });
};
