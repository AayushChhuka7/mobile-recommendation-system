import { findUserById } from "../services/userService.mjs";

export const loadUserById = async (req, res, next) => {
  try {
    const user = await findUserById(req.params.id);
    req.checkUser = user;
    next();
  } catch (error) {
    next(error);
  }
};
