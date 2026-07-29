// profileValidation — express-validator schemas for the self-service
// profile endpoints. Follows the style of userValidation.mjs:
//
//   - `in: ["body"]` for body fields
//   - `optional: { options: { checkFalsy: true } }` for partial updates
//   - clear, per-field error messages
//
// The allowed-fields whitelist passed to `validationWith` is the *exact*
// contract — anything else in the body is rejected with 400.

import { checkSchema } from "express-validator";

const ALLOWED_PERSONAS = ["gamer", "camera", "battery", "allrounder", "Custom"];
const ALLOWED_SORTS = [
  "newest",
  "oldest",
  "name_asc",
  "name_desc",
  "price_asc",
  "price_desc",
  "antutu",
];

// PUT /api/users/me/preferences
// body: { persona, budgetMin?, budgetMax, weights? }
// weights shape: { gaming?: int 1..5, camera?: int 1..5, battery?: int 1..5, display?: int 1..5 }
export const savePreferencesValidation = checkSchema({
  persona: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isIn: {
      options: [ALLOWED_PERSONAS],
      errorMessage: `persona must be one of: ${ALLOWED_PERSONAS.join(", ")}`,
    },
  },
  budgetMin: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isFloat: {
      options: { min: 0, max: 100000 },
      errorMessage: "budgetMin must be a number between 0 and 100000",
    },
    toFloat: true,
  },
  budgetMax: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isFloat: {
      options: { min: 1, max: 100000 },
      errorMessage: "budgetMax must be a number between 1 and 100000",
    },
    toFloat: true,
  },
  "weights.gaming": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isInt: {
      options: { min: 1, max: 5 },
      errorMessage: "weights.gaming must be an integer 1..5",
    },
    toInt: true,
  },
  "weights.camera": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isInt: {
      options: { min: 1, max: 5 },
      errorMessage: "weights.camera must be an integer 1..5",
    },
    toInt: true,
  },
  "weights.battery": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isInt: {
      options: { min: 1, max: 5 },
      errorMessage: "weights.battery must be an integer 1..5",
    },
    toInt: true,
  },
  "weights.display": {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isInt: {
      options: { min: 1, max: 5 },
      errorMessage: "weights.display must be an integer 1..5",
    },
    toInt: true,
  },
});

// PUT /api/users/me/filter-preset
// body: { filters: {...}, sort?: string }
//
// We accept any value for each filter key and only whitelist at the route
// level. The schema only validates `sort` and the envelope shape.
export const saveFilterPresetValidation = checkSchema({
  filters: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    custom: {
      options: (value) => {
        if (value === null || typeof value === "object") return true;
        throw new Error("filters must be an object");
      },
    },
  },
  sort: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isIn: {
      options: [ALLOWED_SORTS],
      errorMessage: `sort must be one of: ${ALLOWED_SORTS.join(", ")}`,
    },
  },
});

// GET /api/users/:id/profile — placeholder so `validationWith` can attach
// any future URL validation. Body is empty.
export const getProfileByIdValidation = checkSchema({});
