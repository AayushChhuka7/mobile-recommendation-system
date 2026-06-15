import { asyncHandler } from "../middleware/errorHandler.mjs";
import { prisma } from "../config/index.mjs";

export const registerUser = asyncHandler(async (req, res, next) => {
  const data = req.data;
  const newUser = await prisma.users.create({
    data: data,
  });
  next();
});
