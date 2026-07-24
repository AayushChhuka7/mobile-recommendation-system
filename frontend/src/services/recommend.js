import api from "./api";

/**
 * Hit the backend ML-powered recommendation endpoint.
 *
 * Backend contract (see backend/src/routes/recommendRoutes.mjs +
 * backend/src/controller/recommendController.mjs +
 * backend/src/services/recommendService.mjs):
 *
 *   POST /api/recommend/recommend
 *   {
 *     persona: "gamer" | "camera" | "battery" | "allrounder",
 *     budget:  { min?: number, max: number },
 *     preferences?: { gaming?, camera?, battery?, display? },  // 1..5
 *     topN?: number                                            // default 6
 *   }
 *
 *   200 → { success: true, data: Recommendation[], message }
 *
 * Each Recommendation in `data` is shaped like:
 *   {
 *     id, modelName, brand, imageUrl, antutuScore,
 *     keySpecs: { os, display, refreshRate, camera, battery, has5G, hasNfc },
 *     cheapestVariant: { ram, storage, price, storageType } | null,
 *     matchScore, why: string[], inDatabase
 *   }
 */
export async function getRecommendations({
  persona,
  budget,
  preferences,
  topN = 6,
}) {
  const res = await api.post("/recommend/recommend", {
    persona,
    budget,
    preferences,
    topN,
  });
  // Backend success envelope: { success, data, message? }
  return res?.data?.data ?? [];
}

/**
 * Hit the backend ML-powered phone-vs-phone comparison endpoint.
 *
 * Backend contract (see backend/src/routes/recommendRoutes.mjs +
 * backend/src/controller/recommendController.mjs +
 * backend/src/services/recommendService.mjs +
 * ML Model/pipeline/model.py :: MobileRecommendationPipeline.compare_phones):
 *
 *   POST /api/recommend/compare-ml
 *   {
 *     modelNameA: string,   // exact Model_Name of phone A
 *     modelNameB: string,   // exact Model_Name of phone B
 *   }
 *
 *   200 → { success: true, data: <CompareMLResult>, message }
 *
 * The `data` payload shape:
 *   {
 *     Phone_A: string,                 // model name of A
 *     Price_A: number | null,
 *     Phone_B: string,                 // model name of B
 *     Price_B: number | null,
 *     Dimension_Comparison: {
 *       Gaming:        { A, B, Winner },   // per-dim score
 *       Camera:        { A, B, Winner },
 *       Battery:       { A, B, Winner },
 *       Display:       { A, B, Winner },
 *       Software:      { A, B, Winner },
 *       Storage:       { A, B, Winner },
 *       Connectivity:  { A, B, Winner },
 *       Security:      { A, B, Winner },
 *       Portability:   { A, B, Winner },
 *     },
 *     Overall_Winner: string,          // Phone_A | Phone_B | "Tie"
 *     SHAP_A: [{ feature, shap }],     // top-5 positive contributors to A's score
 *     SHAP_B: [{ feature, shap }],
 *   }
 */
export async function postCompareMl({ modelNameA, modelNameB }) {
  console.log("Calling endpoint:", "/recommend/compare-ml");
  console.log("Full URL:", api.defaults.baseURL + "/recommend/compare-ml");
  if (!modelNameA || !modelNameB) {
    throw new Error("Both modelNameA and modelNameB are required");
  }
  const res = await api.post("/recommend/compare-ml", {
    modelNameA,
    modelNameB,
  });
  // Backend success envelope: { success, data, message? }
  return res?.data?.data ?? null;
}
