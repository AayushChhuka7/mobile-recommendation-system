import { Router } from "express";
import {
  getAutoRecommend,
  getHealth,
  postCompareML,
  postRecommend,
} from "../controller/recommendController.mjs";

export const recommendRoutes = Router();

recommendRoutes.get("/health", getHealth);
recommendRoutes.post("/recommend", postRecommend);
recommendRoutes.post("/compare-ml", postCompareML);
// Auto-recommend — Dashboard hits this on mount. Reuses the same
// fusion pipeline as POST /recommend; persona + budget derived from
// the stored profile. No body required.
recommendRoutes.get("/auto", getAutoRecommend);
