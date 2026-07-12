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