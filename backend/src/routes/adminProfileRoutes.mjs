// adminProfileRoutes — admin-only customer profile read endpoint.
//
// Mounted under /api/users, AFTER self-service /me routes so the literal
// /me wins over the admin `/:id` wildcard.
//
// Endpoints:
//   GET /:id/profile       — admin-only; returns the full bundle shape
//                            for the requested target user.
//   GET /:id/behavior      — admin-only; returns the user's BehaviorScore
//                            rows for the Step B "Behaviour scores"
//                            section on the admin detail page.

import { Router } from "express";
import { isAuthenticate } from "../middleware/auth.mjs";
import { loadUserContext } from "../middleware/loadUserContext.mjs";
import { loadUserById } from "../middleware/userLoader.mjs";
import { requireRole } from "../middleware/requireRole.mjs";
import { catchAsync } from "../utils/catchAsync.mjs";
import { sendSuccess } from "../utils/ApiResponse.mjs";
import { prisma } from "../config/prisma.mjs";
import { getCustomerProfileById } from "../services/profileService.mjs";

export const adminProfileRoutes = Router();

// Authentication is checked for every request to this router; the admin
// role check is attached per-route so unrelated requests that fall
// through here (e.g. /users/me/preferences handled by ownProfileRoutes)
// don't get rejected by an inherited admin gate.
adminProfileRoutes.use(isAuthenticate, loadUserContext);

// GET /api/users/:id/profile
adminProfileRoutes.get(
  "/:id/profile",
  requireRole("Admin"),
  loadUserById,
  catchAsync(async (req, res) => {
    const bundle = await getCustomerProfileById(req.checkUser.userId);
    return sendSuccess(res, bundle, {
      message: `Profile bundle for user ${req.checkUser.userId}`,
    });
  }),
);

// GET /api/users/:id/behavior
// Step B — admin view of the Step B BehaviorScore rows for any user.
// Sorted score-desc, same shape as the self-service /events/behavior/me.
adminProfileRoutes.get(
  "/:id/behavior",
  requireRole("Admin"),
  loadUserById,
  catchAsync(async (req, res) => {
    const targetUserId = req.checkUser.userId;
    const rows = await prisma.behaviorScore.findMany({
      where: { userId: targetUserId },
      orderBy: [{ score: "desc" }, { tag: "asc" }],
      select: { tag: true, score: true, updatedAt: true },
    });
    return sendSuccess(
      res,
      rows.map((r) => ({
        tag: r.tag,
        score: Number(r.score),
        updatedAt: r.updatedAt,
      })),
      { message: `Behaviour scores for user ${targetUserId}` },
    );
  }),
);
