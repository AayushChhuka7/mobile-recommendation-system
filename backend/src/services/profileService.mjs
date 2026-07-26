// profileService — persistence layer for the user-side Step A tables.
//
// Three Prisma models back the saved profile:
//   - UserProfile   — demographic fields (age, gender, location)
//   - UserPreference — the *questionnaire* answers (budget, usage,
//                      camera pref, preferred brand)
//   - CustomerProfile — derived / aggregated segment metadata
//                      (budget_segment, tech_tier, persona snapshot, etc.)
//
// All writes use `upsert` keyed on `userId` so the endpoint is idempotent:
// first call inserts, subsequent calls update.
//
// Raw Prisma errors (P2002 / P2025 / P2003) bubble up to the global
// errorHandler — see `prismaErrorMap` in utils/ApiError.mjs.

import { prisma } from "../config/prisma.mjs";
import { notFound } from "../utils/ApiError.mjs";

const INCLUDE = {
  profile: true,
  preference: {
    include: { preferredBrand: { select: { brandId: true, name: true } } },
  },
  customerProfile: true,
};

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

// Map a Prisma decimal-like value to a plain JS number the FE can render.
const dec = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Load the full saved profile for a user. Returns `null` if no row exists
 * (so the FE can prompt the user to onboard). Throws nothing for the
 * "first-time" case.
 */
export const findProfileByUserId = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { userId },
    include: INCLUDE,
  });
  if (!user) {
    throw notFound("User not found");
  }
  return {
    userId: user.userId,
    name: user.name,
    email: user.email,
    profile: user.profile
      ? {
          age: user.profile.age ?? null,
          gender: user.profile.gender ?? null,
          country: user.profile.country ?? null,
          state: user.profile.state ?? null,
          city: user.profile.city ?? null,
        }
      : null,
    preference: user.preference
      ? {
          maxBudget: dec(user.preference.maxBudget),
          cameraPreference: user.preference.cameraPreference,
          usageType: user.preference.usageType,
          preferredBrand: user.preference.preferredBrand
            ? {
                brandId: user.preference.preferredBrand.brandId,
                name: user.preference.preferredBrand.name,
              }
            : null,
        }
      : null,
    customerProfile: user.customerProfile
      ? {
          budgetSegment: user.customerProfile.budgetSegment,
          techTier: user.customerProfile.techTier,
          cameraPreference: user.customerProfile.cameraPreference,
          favoriteBrand: user.customerProfile.favoriteBrand,
          preferredRamGb: user.customerProfile.preferredRamGb,
          preferredStorageGb: user.customerProfile.preferredStorageGb,
          recommendationPersona: user.customerProfile.recommendationPersona,
          segmentConfidence: user.customerProfile.segmentConfidence,
          searchCount: user.customerProfile.searchCount,
          totalRecommendations: user.customerProfile.totalRecommendations,
        }
      : null,
  };
};

/**
 * First-time onboarding. Writes all three rows in a single transaction
 * so the user never lands in a half-saved state. Idempotent: re-running
 * with the same payload keeps the existing ids and just overwrites
 * values.
 */
export const onboardProfile = async (userId, body) => {
  const {
    persona,
    budget,
    preferences,
    usageType,
    cameraPreference,
    preferredBrandId,
    maxBudget,
    age,
    gender,
    country,
    state,
    city,
  } = body;

  // ---- normalise inputs ----
  // `budget` (FE shape: { min, max }) and `maxBudget` (DB shape) are
  // accepted interchangeably; `maxBudget` wins if both are given.
  const resolvedMax =
    toNumber(maxBudget) ??
    (budget && toNumber(budget.max)) ??
    null;

  if (resolvedMax === null) {
    // Surface as a 400 to the controller layer; the controller will
    // throw badRequest with a clearer message.
    throw new Error("budget.max (or maxBudget) is required");
  }

  // Prefer the explicitly-stated usageType / cameraPreference enums.
  // If only the FE's `persona` was sent, derive them.
  const resolvedUsage = usageType || personaToUsageType(persona);
  const resolvedCamera =
    cameraPreference || personaToCameraPreference(persona);

  return prisma.$transaction(async (tx) => {
    // UserProfile (demographic) — optional, upsert only if at least one
    // demographic field was provided.
    const hasDemographic =
      age !== undefined ||
      gender !== undefined ||
      country !== undefined ||
      state !== undefined ||
      city !== undefined;
    if (hasDemographic) {
      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          ...(age !== undefined ? { age } : {}),
          ...(gender !== undefined ? { gender } : {}),
          ...(country !== undefined ? { country } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(city !== undefined ? { city } : {}),
        },
        update: {
          ...(age !== undefined ? { age } : {}),
          ...(gender !== undefined ? { gender } : {}),
          ...(country !== undefined ? { country } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(city !== undefined ? { city } : {}),
        },
      });
    }

    // UserPreference — required for onboarding.
    if (resolvedUsage && resolvedCamera) {
      await tx.userPreference.upsert({
        where: { userId },
        create: {
          userId,
          maxBudget: resolvedMax,
          cameraPreference: resolvedCamera,
          usageType: resolvedUsage,
          ...(preferredBrandId ? { preferredBrandId } : {}),
        },
        update: {
          maxBudget: resolvedMax,
          cameraPreference: resolvedCamera,
          usageType: resolvedUsage,
          ...(preferredBrandId !== undefined
            ? { preferredBrandId: preferredBrandId || null }
            : {}),
        },
      });
    }

    // CustomerProfile — derived / rolling stats. Always upsert a row so
    // the "confirmed" state machine has somewhere to live. We seed the
    // default counters here; persona is recorded as
    // `recommendationPersona` for later fusion in the controller.
    await tx.customerProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...(persona ? { recommendationPersona: persona } : {}),
        searchCount: 0,
        totalRecommendations: 0,
        totalComparisons: 0,
        totalWishlist: 0,
      },
      update: {
        ...(persona ? { recommendationPersona: persona } : {}),
      },
    });

    return findProfileByUserId(userId);
  });
};

/**
 * Partial update. Only the fields present in the body are touched.
 * Used when the user tweaks one slider in the FE without redoing the
 * whole questionnaire.
 */
export const patchProfile = async (userId, body) => {
  const { profile, preference, customerProfile } = body;

  return prisma.$transaction(async (tx) => {
    if (profile && typeof profile === "object") {
      const data = {};
      if ("age" in profile) data.age = profile.age;
      if ("gender" in profile) data.gender = profile.gender;
      if ("country" in profile) data.country = profile.country;
      if ("state" in profile) data.state = profile.state;
      if ("city" in profile) data.city = profile.city;
      if (Object.keys(data).length > 0) {
        await tx.userProfile.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
      }
    }

    if (preference && typeof preference === "object") {
      const data = {};
      if ("maxBudget" in preference) data.maxBudget = preference.maxBudget;
      if ("cameraPreference" in preference)
        data.cameraPreference = preference.cameraPreference;
      if ("usageType" in preference) data.usageType = preference.usageType;
      if ("preferredBrandId" in preference)
        data.preferredBrandId = preference.preferredBrandId || null;
      if (Object.keys(data).length > 0) {
        await tx.userPreference.upsert({
          where: { userId },
          create: {
            userId,
            maxBudget: data.maxBudget ?? 0,
            cameraPreference: data.cameraPreference ?? "Sensible",
            usageType: data.usageType ?? "Casual",
            ...(data.preferredBrandId !== undefined
              ? { preferredBrandId: data.preferredBrandId }
              : {}),
          },
          update: data,
        });
      }
    }

    if (customerProfile && typeof customerProfile === "object") {
      const data = {};
      for (const k of [
        "budgetSegment",
        "techTier",
        "favoriteBrand",
        "preferredRamGb",
        "preferredStorageGb",
        "recommendationPersona",
      ]) {
        if (k in customerProfile) data[k] = customerProfile[k];
      }
      if (Object.keys(data).length > 0) {
        await tx.customerProfile.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
      }
    }

    return findProfileByUserId(userId);
  });
};

/**
 * Resolve a persona back into the FE-friendly shape used by the
 * recommender. Used by `recommendService` when a logged-in user hits
 * POST /api/recommend/recommend with an empty body.
 *
 * Returns `null` if the user has no stored profile — the controller
 * will then throw 400 telling the FE to onboard first.
 */
export const loadRecommendationInput = async (userId) => {
  const user = await prisma.users.findUnique({
    where: { userId },
    include: INCLUDE,
  });
  if (!user) {
    throw notFound("User not found");
  }
  if (!user.preference) {
    return null;
  }

  const persona = user.customerProfile?.recommendationPersona || null;
  const maxBudget = dec(user.preference.maxBudget);

  return {
    persona,
    budget: {
      min: 0,
      max: maxBudget,
    },
    // `preferences` (1..5 sliders) is filled in by the FE per request —
    // we don't persist slider values yet, so leave it null and let the
    // FE pass them if it has fresh state.
    preferences: null,
  };
};

// ---- internal helpers ----

// Map the FE's `persona` key to the `UsageType` enum value. The mapping
// is intentionally lossy — the FE's persona is a "primary interest" and
// the DB's usageType is a broader bucket. Step F (Profile Evolution)
// will refine this over time.
const personaToUsageType = (persona) => {
  switch ((persona || "").toLowerCase()) {
    case "gamer":
      return "Gamer";
    case "camera":
      return "Creator";
    case "battery":
      return "Casual";
    case "business":
      return "Business";
    case "allrounder":
    case "custom":
    default:
      return "Casual";
  }
};

const personaToCameraPreference = (persona) => {
  switch ((persona || "").toLowerCase()) {
    case "camera":
      return "Photophile";
    case "gamer":
    case "business":
    case "allrounder":
    case "battery":
    case "custom":
    default:
      return "Sensible";
  }
};
