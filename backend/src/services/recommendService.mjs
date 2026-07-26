import { ML_BASE_URL } from "../config/ml.mjs";
import { badRequest, internal } from "../utils/ApiError.mjs";
import { prisma } from "../config/prisma.mjs";
import * as profileService from "./profileService.mjs";

const TIMEOUT_MS = 8000;

const mlFetch = async (path, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ML_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      throw badRequest(data.message || data.detail || "ML service error");
    }

    return data;
  } catch (err) {
    if (err.statusCode) throw err;
    if (err.name === "AbortError") throw internal("ML service timed out");
    throw internal(`ML service unreachable (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
};

export const checkHealth = async () => {
  return mlFetch("/health");
};

/**
 * Step A — `mergeWithStoredProfile`.
 *
 * For an authenticated user, if the request body is missing `persona`
 * or `budget.max`, hydrate them from the user's stored profile so a
 * returning user can hit POST /api/recommend/recommend with an empty
 * body and still get sensible results.
 *
 * Anonymous callers (`!user`) get their body unchanged. If even a
 * logged-in user submits a body that is missing both fields AND has no
 * stored profile, the service throws a 400 with a hint to onboard.
 *
 * Returns the merged body. Does NOT mutate the caller's body.
 */
export const mergeWithStoredProfile = async (body, user) => {
  const merged = { ...(body || {}) };

  const hasPersona =
    typeof merged.persona === "string" && merged.persona.length > 0;
  const budgetMax =
    merged.budget && typeof merged.budget.max === "number"
      ? merged.budget.max
      : null;
  const hasBudget = budgetMax !== null;

  if (hasPersona && hasBudget) return merged;
  if (!user || !user.userId) {
    // Anonymous caller without a complete body — keep existing 400
    // behaviour (let `getRecommendations` validate and throw).
    return merged;
  }

  const stored = await profileService.loadRecommendationInput(user.userId);
  if (!stored) {
    // Logged-in user with no saved profile. Surface a clearer error
    // than the generic "persona is required".
    throw badRequest(
      "No stored profile found. Complete the questionnaire or pass persona + budget in the body.",
      { reason: "no_stored_profile" },
    );
  }

  if (!hasPersona && stored.persona) {
    merged.persona = stored.persona;
  }
  if (!hasBudget && stored.budget && typeof stored.budget.max === "number") {
    merged.budget = {
      ...(merged.budget || {}),
      min: stored.budget.min ?? 0,
      max: stored.budget.max,
    };
  }
  return merged;
};

export const getRecommendations = async (body) => {
  const { persona, budget, preferences, topN } = body || {};

  if (!persona) throw badRequest("persona is required");
  if (!budget || typeof budget.max !== "number")
    throw badRequest("budget.max is required");

  // 1. Get ML results
  const data = await mlFetch("/recommend", {
    method: "POST",
    body: JSON.stringify({
      persona,
      budget: { min: budget.min || 0, max: budget.max },
      preferences: preferences || {},
      topN: topN || 6,
    }),
  });

  const mlResults = data.results || [];

  if (mlResults.length === 0) return [];

  // 2. Enrich with database data
  const enriched = await Promise.all(
    mlResults.map(async (item) => {
      const phone = await prisma.phones.findFirst({
        where: {
          modelName: { contains: item.Model, mode: "insensitive" },
          brand: { name: { contains: item.Brand, mode: "insensitive" } },
          isActive: true,
        },
        include: {
          brand: { select: { brandId: true, name: true, logoUrl: true } },
          specs: {
            select: {
              os: true,
              chipset: true,
              displaySize: true,
              displayType: true,
              refreshRate: true,
              mainCamera: true,
              batteryMah: true,
              supports5g: true,
              supportsNfc: true,
            },
          },
          variants: {
            where: { isAvailable: true },
            orderBy: { price: "asc" },
            select: {
              variantId: true,
              ramGb: true,
              storageGb: true,
              price: true,
              storageType: true,
            },
          },
        },
      });

      return formatRecommendation(item, phone);
    }),
  );

  return enriched;
};

// Format ML result + DB data into frontend-friendly shape
const formatRecommendation = (mlItem, phone) => {
  if (!phone) {
    return {
      id: null,
      modelName: mlItem.Model,
      brand: { name: mlItem.Brand },
      imageUrl: null,
      keySpecs: null,
      cheapestVariant: { price: mlItem.Price_EUR },
      matchScore: mlItem.Match_Score,
      why: mlItem.Why || [],
      inDatabase: false,
    };
  }

  const cheapestVariant = phone.variants?.[0];

  return {
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,
    brand: phone.brand,
    keySpecs: {
      os: phone.specs?.os || null,
      display: phone.specs?.displaySize || null,
      refreshRate: phone.specs?.refreshRate || null,
      camera: phone.specs?.mainCamera || null,
      battery: phone.specs?.batteryMah || null,
      has5G: phone.specs?.supports5g || false,
      hasNfc: phone.specs?.supportsNfc || false,
    },
    cheapestVariant: cheapestVariant
      ? {
          ram: cheapestVariant.ramGb,
          storage: cheapestVariant.storageGb,
          price: cheapestVariant.price,
          storageType: cheapestVariant.storageType,
        }
      : null,
    matchScore: mlItem.Match_Score,
    why: mlItem.Why || [],
    inDatabase: true,
  };
};
