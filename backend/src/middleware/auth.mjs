export const isAuthenticate = (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "please login" });
  }
  next();
};
