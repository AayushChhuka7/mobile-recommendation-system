import { Router } from "express";
import {
  getAutoRecommend,
  getHealth,
  postCompareML,
  postImpression,
  postRecommend,
  postRecommendSlice,
} from "../controller/recommendController.mjs";

export const recommendRoutes = Router();

recommendRoutes.get("/health", getHealth);
recommendRoutes.post("/recommend", postRecommend);
recommendRoutes.post("/compare-ml", postCompareML);
// Fix #8 — lazy expansion. The FE calls this as the user scrolls
// past the eager slice.
recommendRoutes.post("/recommend/slice", postRecommendSlice);
// Fix #1 — FE-driven impression batch. The FE posts dwell/skip/
// click deltas here every 5s (or on visibilitychange).
recommendRoutes.post("/impressions", postImpression);
// Auto-recommend — Dashboard hits this on mount. Reuses the same
// fusion pipeline as POST /recommend; persona + budget derived from
// the stored profile. No body required.
recommendRoutes.get("/auto", getAutoRecommend);
