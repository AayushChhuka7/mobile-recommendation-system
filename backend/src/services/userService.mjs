import { prisma } from "../config/prisma.mjs";
import { notFound, accountDeactivated } from "../utils/ApiError.mjs";

// userService — non-RBAC user-row CRUD.
//
// Role / permission helpers live in `rbacService.mjs`.
//
// Error policy (Phase 2): every explicit "this should not exist" case
// throws a typed factory from `utils/ApiError.mjs` so the global
// errorHandler can attach the right HTTP status + code. Raw Prisma
// errors (P2002, P2025, P2003) bubble up unhandled and are mapped
// centrally in the errorHandler — see `prismaErrorMap`.
//
// Functions that intentionally let Prisma errors bubble:
//   - createUser        → P2002 (DUPLICATE_ENTRY) handled by mapper
//   - updateUser        → P2025 (RECORD_NOT_FOUND) handled by mapper
//   - deleteUser        → P2025 (RECORD_NOT_FOUND) handled by mapper
//   - deactivateOwnAccount → P2025 handled by mapper
//   - findUserByEmail   → returns null on miss (Passport expects this)

export const findAllUsers = async () => {
<<<<<<< HEAD
  return prisma.users.findMany();
=======
  // Explicit `select` so the bcrypt hash and any other future sensitive
  // column never leaks to the browser. The role is a relation to Roles;
  // selecting `roleName` returns `{ roleName: "Admin" }` which the FE
  // can flatten if it wants.
  return prisma.users.findMany({
    select: {
      userId: true,
      name: true,
      email: true,
      phoneNo: true,
      isActive: true,
      isVerified: true,
      role: { select: { roleName: true } },
    },
  });
>>>>>>> proxy-dev
};

export const findUserById = async (id) => {
  const user = await prisma.users.findUnique({
    where: { userId: id },
  });
  if (!user) {
    throw notFound("User not found");
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
    throw notFound("User not found");
  }
  if (!user.isActive) {
    throw accountDeactivated("Account is deactivated");
  }
  return user;
};
