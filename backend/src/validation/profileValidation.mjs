// profileValidation — express-validator schemas for Step A's profile routes.
//
// These are intentionally permissive: the FE may send either the
// questionnaire-style fields (persona + budget + preferences) or the
// database-shape fields (usageType / cameraPreference / maxBudget / etc.).
// The controller accepts either shape.
//
// `allowedFields` lists passed to `validationWith` use these top-level
// keys. Sub-objects (`profile`, `preference`, `customerProfile`) on
// PATCH /me are not deeply whitelisted — the controller treats unknown
// sub-keys as no-ops via the `in` checks below.

import { checkSchema } from "express-validator";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const isUuid = {
  in: ["body"],
  optional: { options: { checkFalsy: true } },
  matches: {
    options: UUID_RE,
    errorMessage: "preferredBrandId must be a UUID",
  },
};

const numField = (key, { min = 0, max = 1_000_000, required = true } = {}) => ({
  in: ["body"],
  ...(required
    ? { notEmpty: { errorMessage: `${key} is required` } }
    : { optional: { options: { checkFalsy: true } } }),
  isFloat: {
    options: { min, max },
    errorMessage: `${key} must be a number between ${min} and ${max}`,
  },
  toFloat: true,
});

const intField = (key, { min = 0, max = 100, required = true } = {}) => ({
  in: ["body"],
  ...(required
    ? { notEmpty: { errorMessage: `${key} is required` } }
    : { optional: { options: { checkFalsy: true } } }),
  isInt: {
    options: { min, max },
    errorMessage: `${key} must be an integer between ${min} and ${max}`,
  },
  toInt: true,
});

const enumField = (key, allowed) => ({
  in: ["body"],
  optional: { options: { checkFalsy: true } },
  isIn: {
    options: [allowed],
    errorMessage: `${key} must be one of: ${allowed.join(", ")}`,
  },
});

// ---- Onboard (POST /me/onboard) ----
//
// Accepts either:
//   - FE questionnaire shape: { persona, budget: { min, max }, preferences, ... }
//   - DB shape:               { maxBudget, usageType, cameraPreference, preferredBrandId, ... }
// Both may be combined. At least one of `budget.max` or `maxBudget` is required.

export const onboardProfileValidation = checkSchema({
  // FE-friendly fields
  persona: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: { errorMessage: "persona must be a string" },
    isLength: {
      options: { min: 1, max: 40 },
      errorMessage: "persona must be 1-40 chars",
    },
  },
  budget: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "budget must be an object" },
  },
  "budget.max": {
    optional: { options: { checkFalsy: true } },
    isFloat: {
      options: { min: 0, max: 1_000_000 },
      errorMessage: "budget.max must be a number between 0 and 1,000,000",
    },
    toFloat: true,
  },
  "budget.min": {
    optional: { options: { checkFalsy: true } },
    isFloat: {
      options: { min: 0, max: 1_000_000 },
      errorMessage: "budget.min must be a number between 0 and 1,000,000",
    },
    toFloat: true,
  },
  preferences: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "preferences must be an object" },
  },

  // DB-shape fields (accepted either for direct writes or as overrides)
  maxBudget: {
    ...numField("maxBudget", { min: 0, max: 1_000_000, required: false }),
  },
  usageType: enumField("usageType", [
    "Student",
    "Gamer",
    "Business",
    "Casual",
    "Creator",
  ]),
  cameraPreference: enumField("cameraPreference", [
    "Sensible",
    "Photophile",
    "SelfieAddict",
  ]),
  preferredBrandId: isUuid,

  // Demographic (optional)
  age: intField("age", { min: 10, max: 120, required: false }),
  gender: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 20 } },
  },
  country: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },
  state: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },
  city: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },
});

// ---- Patch (PATCH /me) ----
//
// Each top-level key (profile, preference, customerProfile) is optional.
// Unknown sub-keys pass through but are ignored by the service layer.

export const patchProfileValidation = checkSchema({
  profile: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "profile must be an object" },
  },
  "profile.age": {
    optional: { options: { checkFalsy: true } },
    isInt: { options: { min: 10, max: 120 } },
    toInt: true,
  },
  "profile.gender": {
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 20 } },
  },
  "profile.country": {
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },
  "profile.state": {
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },
  "profile.city": {
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 80 } },
  },

  preference: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "preference must be an object" },
  },
  "preference.maxBudget": {
    optional: { options: { checkFalsy: true } },
    isFloat: { options: { min: 0, max: 1_000_000 } },
    toFloat: true,
  },
  "preference.cameraPreference": enumField("cameraPreference", [
    "Sensible",
    "Photophile",
    "SelfieAddict",
  ]),
  "preference.usageType": enumField("usageType", [
    "Student",
    "Gamer",
    "Business",
    "Casual",
    "Creator",
  ]),
  "preference.preferredBrandId": isUuid,

  customerProfile: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "customerProfile must be an object" },
  },
  "customerProfile.budgetSegment": enumField("budgetSegment", [
    "BudgetExplorer",
    "AffordableBuyer",
    "MidRangeBuyer",
    "PremiumBuyer",
    "LuxuryBuyer",
  ]),
  "customerProfile.techTier": enumField("techTier", [
    "Budget",
    "Reasonable",
    "FlagshipKiller",
    "TechSavvy",
    "Luxurious",
  ]),
  "customerProfile.favoriteBrand": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 60 } },
  },
  "customerProfile.preferredRamGb": {
    optional: { options: { checkFalsy: true } },
    isInt: { options: { min: 1, max: 32 } },
    toInt: true,
  },
  "customerProfile.preferredStorageGb": {
    optional: { options: { checkFalsy: true } },
    isInt: { options: { min: 1, max: 2048 } },
    toInt: true,
  },
  "customerProfile.recommendationPersona": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: true,
    isLength: { options: { max: 60 } },
  },
});
