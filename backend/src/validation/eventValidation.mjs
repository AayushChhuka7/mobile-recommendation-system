// eventValidation — Step B validation for POST /api/events.
//
// Uses express-validator (matches the style of profileValidation.mjs +
// userValidation.mjs). Two validators:
//
//   - postEventValidation      → POST /events body (eventType, phoneId?, payload?)
//   - (none for the GET — it has no body)
//
// The validator ONLY enforces shape (string types, allow-listed eventType,
// payload-as-object). Free-form fields inside `payload` are preserved.

import { checkSchema } from "express-validator";

const ALLOWED_EVENT_TYPES = [
  "search",
  "view",
  "compare",
  "click",
  "save",
  "ignore",
  "recommend",
];

// POST /api/events
// body: { eventType, phoneId?, payload? }
//   payload is an arbitrary JSON object — used for free-form context
//   (search query, filter snapshot, comparison model names, …).
export const postEventValidation = checkSchema({
  eventType: {
    in: ["body"],
    exists: {
      errorMessage: "eventType is required",
    },
    isString: {
      errorMessage: "eventType must be a string",
    },
    isIn: {
      options: [ALLOWED_EVENT_TYPES],
      errorMessage: `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(", ")}`,
    },
  },
  phoneId: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    isString: {
      errorMessage: "phoneId must be a string",
    },
    isUUID: {
      errorMessage: "phoneId must be a UUID",
    },
  },
  payload: {
    in: ["body"],
    optional: { options: { checkFalsy: true } },
    custom: {
      options: (value) => {
        // Allow plain objects only (not arrays, not primitives). The
        // express body parser turns objects into JS objects.
        if (value === null) return true;
        if (typeof value === "object" && !Array.isArray(value)) return true;
        throw new Error("payload must be an object");
      },
    },
  },
});

export const EVENT_TYPES = ALLOWED_EVENT_TYPES;
