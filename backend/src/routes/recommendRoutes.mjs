import { Router } from "express";
import {
  getHealth,
  postRecommend,
} from "../controller/recommendController.mjs";

export const recommendRoutes = Router();

recommendRoutes.get("/health", getHealth);
recommendRoutes.post("/recommend", postRecommend);
