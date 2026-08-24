import passport from "passport";
import { Strategy } from "passport-local";
import { prisma } from "../config/prisma.mjs";
import { findUserByEmail } from "../services/userService.mjs";
import { verifyPassword } from "../utils/crypto.mjs";
import { invalidCredentials, unauthorized, accountDeactivated } from "../utils/ApiError.mjs";

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
      // Stale-session guard: if the cookie carries a userId that no longer
      // exists (DB reseed, account deleted, wrong environment), do NOT
      // throw — that aborts the current request before the route handler
      // can do anything. Return `done(null, false)` so Passport treats the
      // user as unauthenticated, lets the request proceed, and lets the
      // login flow overwrite the session with a fresh valid userId via
      // `req.login()` inside `roleGuard`.
      return done(null, false);
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

      // Deactivation gate. `deactivateOwnAccountService` flips
      // `isActive = false`; without this check a deactivated user
      // could still sign in because nothing else in the login path
      // (roleGuard, passport.authenticate) inspects the flag. The
      // `accountDeactivated` factory returns 403 with code
      // AUTH_ACCOUNT_DEACTIVATED, which the FE surfaces as a
      // dedicated "this account has been deactivated" banner.
      if (findUser.isActive === false) {
        throw accountDeactivated('This account has been deactivated');
      }

      done(null, findUser);
    } catch (error) {
      done(error, null);
    }
  }),
);