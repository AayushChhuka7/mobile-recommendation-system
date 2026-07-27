// eventValidation — express-validator schemas for Step B's event routes.
//
// Mirrors the conventions in profileValidation.mjs:
//   - Optional sub-fields use { options: { checkFalsy: true } } so a
//     missing key isn't a 400.
//   - UUIDs are checked against the same regex.
//   - `payload` is a free-form object but its depth is capped.

import { checkSchema } from "express-validator";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const isUuid = {
  in: ["body"],
  optional: { options: { checkFalsy: true } },
  matches: {
    options: UUID_RE,
    errorMessage: "phoneId must be a UUID",
  },
};

// Valid eventType values. Keep this in sync with EVENT_TYPES in
// behaviorAnalyzer.mjs (the runtime source of truth).
const EVENT_TYPES = [
  "search",
  "view",
  "click",
  "compare",
  "save",
  "dismiss",
  "ignore",
];

export const postEventValidation = checkSchema({
  eventType: {
    in: ["body"],
    notEmpty: { errorMessage: "eventType is required" },
    isString: { errorMessage: "eventType must be a string" },
    isIn: {
      options: [EVENT_TYPES],
      errorMessage: `eventType must be one of: ${EVENT_TYPES.join(", ")}`,
    },
    isLength: {
      options: { max: 40 },
      errorMessage: "eventType must be at most 40 chars",
    },
  },
  phoneId: isUuid,
  payload: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isObject: { errorMessage: "payload must be an object" },
  },
  "payload.q": {
    optional: { options: { checkFalsy: true } },
    isString: { errorMessage: "payload.q must be a string" },
    isLength: { options: { max: 60 } },
  },
  "payload.query": {
    optional: { options: { checkFalsy: true } },
    isString: { errorMessage: "payload.query must be a string" },
    isLength: { options: { max: 60 } },
  },
  "payload.position": {
    optional: { options: { checkFalsy: true } },
    isInt: {
      options: { min: 0, max: 200 },
      errorMessage: "payload.position must be an integer in [0,200]",
    },
    toInt: true,
  },
});