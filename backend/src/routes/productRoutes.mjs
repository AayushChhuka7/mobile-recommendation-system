import { Router } from "express";

export const productRoutes = Router();

productRoutes.get("/", (req, res) => {
  res.status(200).json({ message: "Product page" });
});
