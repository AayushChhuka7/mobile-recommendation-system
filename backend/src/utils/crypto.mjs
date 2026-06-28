import crypto from "crypto";
import bcrypt from "bcrypt";

export const generateOtp = () => {
  return crypto.randomInt(100000, 999999).toString();
};

export const hashPassword = async (password) => {
  return await bcrypt.hash(password, 10);
};

export const verifyPassword = async (password, saved) => {
  return await bcrypt.compare(password, saved);
};
