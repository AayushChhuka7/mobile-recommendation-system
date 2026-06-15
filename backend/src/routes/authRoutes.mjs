import { Router } from "express";
import { mockUsers } from "../mockData/userData.mjs";
import "../stratagies/userStrategy.mjs";
import passport from "passport";
import { asyncHandler } from "../middleware/errorHandler.mjs";
import { validationWith } from "../middleware/userMiddleware.mjs";
import { registerUser } from "../controller/authController.mjs";
import { userCreationValidation } from "../validation/userValidation.mjs";

export const authRoutes = Router();

authRoutes.post("/login", passport.authenticate("local"), (req, res) => {
  console.log(req.session.passport.user);
  return res.status(200).json({
    message: "Login successful",
    user: {
      id: req.user.id,
      email: req.user.email,
    },
  });
});

authRoutes.post("/logout", (req, res, next) => {
  // req.user hatako
  req.logout((err) => {
    if (err) {
      return next(err);
    }

    // Destroy session  in server
    req.session.destroy((sessionErr) => {
      if (sessionErr) {
        return res
          .status(500)
          .json({ message: "Could not log out completely" });
      }
      // browser ko cookie hatako
      res.clearCookie("connect.sid");
      return res.status(200).json({ message: "Logged out successfully" });
    });
  });
});

authRoutes.post(
  "/register",
  validationWith(userCreationValidation),
  registerUser,
  passport.authenticate("local"),
  (req, res) => {
    res.status(201).json({
      messsage: "You have registered your account and you are logeed in",
      seesion: req.session.passport.user,
    });
  },
);
