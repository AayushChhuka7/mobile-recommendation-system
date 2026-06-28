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
