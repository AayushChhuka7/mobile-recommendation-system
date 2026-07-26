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
 *
 * Step A note: a logged-in user may POST this with an empty body — the
 * server falls back to the stored profile. Anonymous callers must
 * still send `persona` + `budget.max`.
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

// --------------------------------------------------------------------
// Step A — customer profile persistence (explicit save + load)
// --------------------------------------------------------------------

/**
 * Persist the user's recommendation preferences so returning users
 * don't re-fill the form. Accepts either the FE questionnaire shape
 * (persona + budget + preferences) or the DB shape (usageType +
 * cameraPreference + maxBudget); the backend normalises both.
 *
 *   POST /api/profile/onboard
 *   201 → { success: true, data: <saved profile>, message }
 *
 * Returns the saved profile object, or `null` on failure (network /
 * auth). Callers should not block their main flow on this — it is a
 * fire-and-forget UX improvement.
 */
export async function saveProfile({
  persona,
  budget,
  preferences,
  usageType,
  cameraPreference,
  maxBudget,
}) {
  try {
    const res = await api.post("/profile/onboard", {
      persona,
      budget,
      preferences,
      usageType,
      cameraPreference,
      maxBudget,
    });
    return res?.data?.data ?? null;
  } catch (err) {
    // Don't block the dashboard on save failure — log and move on.
    // 401 means the user is not logged in (no need to spam the
    // console); anything else is a real problem worth surfacing.
    if (err.response?.status !== 401) {
      console.warn("[saveProfile] failed:", err);
    }
    return null;
  }
}

/**
 * Load the saved profile (used to pre-fill the questionnaire on mount).
 *
 *   GET /api/profile/me
 *   200 → { success: true, data: { preference, customerProfile, ... } | null }
 *
 * Returns `null` if no profile exists yet (FE should show the
 * questionnaire) or on auth failure.
 */
export async function loadSavedProfile() {
  try {
    const res = await api.get("/profile/me");
    return res?.data?.data ?? null;
  } catch (err) {
    if (err.response?.status !== 401) {
      console.warn("[loadSavedProfile] failed:", err);
    }
    return null;
  }
}