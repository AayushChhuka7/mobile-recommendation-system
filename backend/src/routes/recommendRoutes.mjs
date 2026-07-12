import { Router } from "express";
import {
  getHealth,
  postCompareML,
  postRecommend,
} from "../controller/recommendController.mjs";

export const recommendRoutes = Router();

recommendRoutes.get("/health", getHealth);
recommendRoutes.post("/recommend", postRecommend);
recommendRoutes.post("/compare-ml", postCompareML);
