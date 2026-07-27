// eventRoutes — Step B end-points. Mounted at /api/events in main.mjs.
//
//   POST /api/events              log a single interaction event
//   GET  /api/events/behavior/me  return rolled-up behaviour_scores dict
//
// Both require an authenticated session. There is intentionally no
// `GET /api/events` endpoint — the raw event log is internal-only
// (Step F's evolution engine reads it directly, no FE surface).

import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { validationWith } from "../middleware/validator.mjs";
import { postEventValidation } from "../validation/eventValidation.mjs";
import { postEvent, getBehavior } from "../controller/eventController.mjs";

export const eventRoutes = Router();

eventRoutes.use(isAuthenticate);

// POST / — accept only the three documented top-level keys so the
// FE can't accidentally spam extra fields into `events.payload`.
const POST_EVENT_ALLOWED = ["eventType", "phoneId", "payload"];

eventRoutes.post(
  "/",
  validationWith(postEventValidation, POST_EVENT_ALLOWED),
  postEvent,
);

// GET /behavior/me — no body, no query, no auth extras beyond
// `isAuthenticate` (already applied above).
eventRoutes.get("/behavior/me", getBehavior);