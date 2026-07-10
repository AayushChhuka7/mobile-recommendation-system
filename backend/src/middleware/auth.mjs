import { unauthorized } from '../utils/ApiError.mjs';

export const isAuthenticate = (req, res, next) => {
  if (!req.isAuthenticated()) {
    throw unauthorized('Please login to access this resource');
  }
  next();
};