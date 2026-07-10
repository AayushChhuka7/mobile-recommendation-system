import { catchAsync } from "../utils/catchAsync.mjs";
import { findUserById } from "../services/userService.mjs";

export const loadUserById = catchAsync(async (req, res, next) => {
  const user = await findUserById(req.params.id);
  req.checkUser = user;
  next();
});
