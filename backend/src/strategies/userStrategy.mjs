import passport from "passport";
import { Strategy } from "passport-local";
import { prisma } from "../config/prisma.mjs";
import { findUserByEmail } from "../services/userService.mjs";
import { verifyPassword } from "../utils/crypto.mjs";

passport.serializeUser((user, done) => {
  done(null, user.userId);
});

passport.deserializeUser(async (id, done) => {
  try {
    const findUser = await prisma.users.findUnique({
      where: { userId: id },
    });
    if (!findUser) throw new Error("notfound");
    done(null, findUser);
  } catch (error) {
    done(error, null);
  }
});

export default passport.use(
  new Strategy({ usernameField: "email" }, async (email, password, done) => {
    try {
      const findUser = await findUserByEmail(email);
      if (!findUser) {
        throw new Error("User not found");
      }
      const valid = await verifyPassword(password, findUser.password);
      const verified = findUser.isVerified;

      if (!valid) {
        throw new Error("Invalid Credential");
      }
      if (!verified) {
        throw new Error("please verified your account");
      }
      done(null, findUser);
    } catch (error) {
      done(error, null);
    }
  }),
);
