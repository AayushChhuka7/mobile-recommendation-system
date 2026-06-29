import passport from "passport";
import { Strategy } from "passport-local";
import { prisma } from "../config/prisma.mjs";
import { findUserByEmail } from "../services/userService.mjs";
import { verifyPassword } from "../utils/crypto.mjs";

passport.serializeUser((user, done) => {
  done(null, user.userId);
});

// Story 1.10: only the safe fields enter the session. Anything attached
// to `req.user` is a subset of the user row — never the password.
passport.deserializeUser(async (id, done) => {
  try {
    const findUser = await prisma.users.findUnique({
      where: { userId: id },
      select: {
        userId: true,
        name: true,
        email: true,
        phoneNo: true,
        isActive: true,
        isVerified: true,
        roleId: true,
      },
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
      // Auth verification still needs the password hash, so the local
      // strategy uses the full row internally. We only attach the safe
      // subset to the session via deserializeUser above.
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