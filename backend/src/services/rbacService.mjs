// rbacService — RBAC Phase 1.
//
// All Role-related Prisma access lives here. userService stays
// focused on the user-row CRUD that has nothing to do with
// authorization. (RBAC Phase 2's permission tables were reverted on
// 2026-07-06; this module owns roles only.)
//
// Phase 1 = one role per user via the `users.roleId` FK. Every
// read/write on that FK goes through this module.

import { prisma } from "../config/prisma.mjs";

// Select used by deserializeUser — `password` and other sensitive
// fields are deliberately excluded. Use this on every code path that
// puts a user onto `req` / the session.
const SAFE_USER_FIELDS = {
  userId: true,
  name: true,
  email: true,
  phoneNo: true,
  isActive: true,
  isVerified: true,
  roleId: true,
};

export const SAFE_USER_SELECT = SAFE_USER_FIELDS;

// Select used by role-aware lookups: pulls the joined role name.
const ROLES_SAFE_USER_FIELDS = {
  userId: true,
  name: true,
  email: true,
  phoneNo: true,
  isActive: true,
  isVerified: true,
  role: { select: { roleId: true, roleName: true } },
};

// ---- Role lookups ----

export const findRoleByName = async (roleName) => {
  return prisma.roles.findUnique({ where: { roleName } });
};

export const findUserRoles = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { userId },
    select: ROLES_SAFE_USER_FIELDS,
  });
  if (!user) return [];
  
  if (user.role && user.role.roleName) {
    return [user.role.roleName];
  }
  return [];
};

// ---- Role mutations ----

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

// ---- Self-service role assignment ----
//
// `getAssignableRoles` / `isAssignableRole` define the whitelist for
// roles a user can pick at registration. `Admin` is intentionally
// excluded — admins are promoted only via `assignRole` (admin
// endpoint), not through the self-service registration path.
//
// `assertUserRoleMatches` is the login-time check: the FE sends a
// `roleName` with the credentials, and we verify the user's row
// actually holds that role. The login validator is open-string (any
// non-empty role name is accepted at the wire) so admins can log in
// without maintaining a separate login whitelist; the DB row is the
// source of truth.

// Whitelist of roles a user can self-assign at registration.
// `Admin` is admin-only.
const ASSIGNABLE_ROLES = ["Customer", "Salesman"];

export const getAssignableRoles = () => {
  // Return a fresh array so callers can't mutate the source.
  return [...ASSIGNABLE_ROLES];
};

export const isAssignableRole = (roleName) => {
  if (typeof roleName !== "string" || roleName.length === 0) return false;
  return ASSIGNABLE_ROLES.includes(roleName);
};


export const assertUserRoleMatches = async (userId, roleName) => {
  if (typeof userId !== "string" || userId.length === 0) {
    return { matched: false, actualRole: null };
  }
  if (typeof roleName !== "string" || roleName.length === 0) {
    return { matched: false, actualRole: null };
  }

  const userRoles = await findUserRoles(userId);
 
  const actualRole = userRoles.length > 0 ? userRoles[0] : null;
  const matched = actualRole === roleName;
  return { matched, actualRole };
};
