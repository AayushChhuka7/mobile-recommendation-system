// eventRoutes — Step B router for the unified behaviour event log.
//
// Endpoints:
//   POST /                  — record one event (writes Event + upserts
//                             BehaviorScore). Throttled / fire-and-forget
//                             by the FE (see useEventLogger).
//   GET  /behavior/me       — return the caller's rolled-up BehaviorScores.
//                             Used by the FE (debug) and by the admin
//                             CustomerDetail page (top tags view).
//
// No role check — every authenticated user can record their own events
// and read their own scores. The admin-side equivalent will live in
// adminProfileRoutes if/when we add "behaviour view for any user".

import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserContext } from "../middleware/loadUserContext.mjs";
import { validationWith } from "../middleware/validator.mjs";
import { postEvent, getBehavior } from "../controller/eventController.mjs";
import { postEventValidation } from "../validation/eventValidation.mjs";

export const eventRoutes = Router();

// Every route below requires an authenticated, active session.
eventRoutes.use(isAuthenticate, loadUserContext);

// Allow-list enforced by express-validator; the second arg to
// validationWith is the *exact* field whitelist for the body.
eventRoutes.post(
  "/",
  validationWith(postEventValidation, ["eventType", "phoneId", "payload"]),
  postEvent,
);

eventRoutes.get("/behavior/me", getBehavior);
