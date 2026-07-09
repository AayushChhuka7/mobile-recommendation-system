import passport from "passport";
import { Strategy } from "passport-local";
import { prisma } from "../config/prisma.mjs";
import { findUserByEmail } from "../services/userService.mjs";
import { verifyPassword } from "../utils/crypto.mjs";
import { invalidCredentials, unauthorized } from "../utils/ApiError.mjs";

passport.serializeUser((user, done) => {
  done(null, user.userId);
});

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
    
    if (!findUser) {
      throw unauthorized('User not found');
    }
    
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
        throw invalidCredentials('Invalid email or password');
      }
      
      const valid = await verifyPassword(password, findUser.password);
      
      if (!valid) {
        throw invalidCredentials('Invalid email or password');
      }
      
      if (!findUser.isVerified) {
        throw unauthorized('Please verify your account first');
      }
      
      done(null, findUser);
    } catch (error) {
      done(error, null);
    }
  }),
);