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
//
// For `affinity:<phoneId>` rows we additionally resolve the phoneId
// against the `Phones` table so the admin UI can render a friendly
// "Brand · Model" label instead of a raw UUID. Rows that reference a
// phone that's been hard-deleted still come through with the raw tag
// (no `phoneName`) so the admin can see *that* an affinity existed.
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

    // Collect the unique phoneIds referenced by affinity:* tags so
    // we can issue one batched join instead of N queries.
    const affinityPhoneIds = Array.from(
      new Set(
        rows
          .map((r) =>
            typeof r.tag === "string" && r.tag.startsWith("affinity:")
              ? r.tag.slice("affinity:".length)
              : null,
          )
          .filter((id) => typeof id === "string" && id.length > 0),
      ),
    );

    const phoneNameById = new Map();
    if (affinityPhoneIds.length > 0) {
      const phones = await prisma.phones.findMany({
        where: { phoneId: { in: affinityPhoneIds } },
        select: {
          phoneId: true,
          modelName: true,
          brand: { select: { name: true } },
        },
      });
      for (const p of phones) {
        const label =
          p.brand && p.brand.name && p.modelName
            ? `${p.brand.name} · ${p.modelName}`
            : p.modelName || null;
        if (label) phoneNameById.set(p.phoneId, label);
      }
    }

    return sendSuccess(
      res,
      rows.map((r) => {
        const out = {
          tag: r.tag,
          score: Number(r.score),
          updatedAt: r.updatedAt,
        };
        // Only attach `phoneName` for affinity:<uuid> rows; brand/
        // feature/tier/category/model/gaming rows stay unchanged.
        if (typeof r.tag === "string" && r.tag.startsWith("affinity:")) {
          const id = r.tag.slice("affinity:".length);
          const name = phoneNameById.get(id);
          if (name) out.phoneName = name;
        }
        return out;
      }),
      { message: `Behaviour scores for user ${targetUserId}` },
    );
  }),
);
