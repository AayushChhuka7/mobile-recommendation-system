// rbacService — RBAC Phase 1 + Phase 2.
//
// All Role / RolePermission / Permission-related Prisma access lives
// here. userService stays focused on the user-row CRUD that has nothing
// to do with authorization.
//
// Phase 1 (one role per user via `users.roleId` FK) and Phase 2
// (role→permission bundles) both read/write through this module.

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
  // Phase 1 = single role per user. Return an array shape so callers
  // don't have to special-case Phase 2 when it lands.
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

// ---- Permission lookups (Phase 2) ----
//
// `loadUserContext` is the only planned consumer of
// `findUserPermissions`. `findRolePermissions` is exported for the
// upcoming admin endpoint (story 2.9/2.10) but has no current
// caller — keeping the service complete rather than waiting for
// the admin tooling to land.

// Resolves the user's permissions in one query, joining
// users → roles → role_permissions → permissions.
export const findUserPermissions = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { userId },
    select: {
      role: {
        select: {
          permissions: {
            select: {
              permission: { select: { permissionKey: true } },
            },
          },
        },
      },
    },
  });

  if (!user || !user.role) return [];

  const keys = [];
  for (const rp of user.role.permissions) {
    const k = rp.permission.permissionKey;
    if (k) {
      keys.push(k);
    }
  }
  return keys;
};

// Resolves the permission keys granted by a single role. Useful for
// the admin UI ("what does the Salesman role grant?").
export const findRolePermissions = async (roleId) => {
  const role = await prisma.roles.findUnique({
    where: { roleId },
    select: {
      permissions: {
        select: {
          permission: { select: { permissionKey: true } },
        },
      },
    },
  });

  if (!role) return [];

  const keys = [];
  for (const rp of role.permissions) {
    const k = rp.permission.permissionKey;
    if (k) {
      keys.push(k);
    }
  }
  return keys;
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

// Verifies the user holds the requested role. Returns
// `{ matched, actualRole }` — never throws on a normal mismatch,
// so the caller (roleGuard) can drive the 303 response without
// try/catch noise. A missing user surfaces as `actualRole: null`
// so the guard can handle it (e.g. 303 to a "no role" path).
export const assertUserRoleMatches = async (userId, roleName) => {
  if (typeof userId !== "string" || userId.length === 0) {
    return { matched: false, actualRole: null };
  }
  if (typeof roleName !== "string" || roleName.length === 0) {
    return { matched: false, actualRole: null };
  }

  const userRoles = await findUserRoles(userId);
  // Phase 1 = single role per user, so `userRoles` is either [] or
  // a 1-element array. Phase 2 will widen the semantics; the
  // `matched` flag stays correct under either shape.
  const actualRole = userRoles.length > 0 ? userRoles[0] : null;
  const matched = actualRole === roleName;
  return { matched, actualRole };
};
