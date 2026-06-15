import { prisma } from "../config/index.mjs";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { generateRandomUUID } from "../middleware/userMiddleware.mjs";
import { mockUsers } from "../mockData/userData.mjs";

// export const getAllUser = async (req, res, next) => {
//   const {
//     query: { filter, value },
//   } = req;

//   if (filter && value) {
//     const users = mockUsers.filter((user) => {
//       if (user[filter] === undefined || user[filter] === null) {
//         const error = new Error("Send valid filter value");
//         error.status = 400;
//         next(error);
//       }

//       return user[filter].includes(value);
//     });
//     if (users.length === 0)
//       return res.status(404).json({ message: "No such user" });
//     return res.status(200).json(users);
//   }
//   const users = mockUsers;
//   if (!users) return res.status(404).json({ error: "User NOT FOUND" });
//   return res.status(200).json(users);
// };

export const getAllUser = asyncHandler(async (req, res) => {
  const users = await prisma.users.findMany();

  if (users.length === 0) {
    throw new Error("No users found");
  }
  return res.status(200).json(users);
});

export const getUserById = (req, res, next) => {
  const user = req.checkUser;
  return res.status(200).json(user);
};

export const postUser = asyncHandler(async (req, res, next) => {
  const { data } = req;
  const newUser = await prisma.users.create({
    data: data,
  });
  res.status(201).json(newUser);
});

export const patchUser = asyncHandler(async (req, res, next) => {
  const id = req.checkUser.id;
  const data = req.data;

  // const userIndex = mockUsers.findIndex((u) => u.id === id);

  // mockUsers[userIndex] = {
  //   ...mockUsers[userIndex],
  //   ...data,
  // };
  const updatedUser = await prisma.users.update({
    where: { userId: id },
    data: data,
  });

  res.status(200).json({
    message: "User updated successfully",
    user: updatedUser,
  });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const id = req.checkUser.id;
  const deletedUser = await prisma.users.delete({ where: { userId: id } });
  return res.status(200).json({ message: "Deletion Complete" });
});
