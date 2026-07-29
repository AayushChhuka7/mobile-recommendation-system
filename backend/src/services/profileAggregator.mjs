// profileAggregator — computes derived CustomerProfile columns from the
// user's recommendation history.
//
// Three derived columns:
//   - techTier             (enum)    from modal antutuScore across last 25 rows
//   - preferredRamGb       (int)     from modal cheapestVariant.ramGb
//   - preferredStorageGb   (int)     from modal cheapestVariant.storageGb
//
// We use `mode` (most-frequent) instead of mean so a single flagship
// recommendation can't drag a budget-tiered user up to flagship.
//
// Trigger policy: the parent caller invokes
// `safeAggregateAfterRecommendation(userId)` *after* every recommendation
// event. The aggregator is idempotent and cheap when there is nothing
// to do — it bails out if either (a) the user's last aggregate was
// within AGGREGATE_MIN_INTERVAL_MS or (b) fewer than MIN_NEW_ROWS new
// `RecommendationHistory` rows have landed for the user since the last
// aggregate. In normal use this means a single aggregator call per
// every ~5 recommendations.

import { prisma } from "../config/prisma.mjs";

const AGGREGATE_WINDOW = 25;
const MIN_NEW_ROWS = 5;
const AGGREGATE_MIN_INTERVAL_MS = 30_000; // half a minute

// Map a single AnTuTu score to TechTier. Same bands the FE uses for
// the `tier:flagship` / `tier:mid` / `tier:budget` behaviour tags, but
// with finer granularity (5 buckets instead of 3).
export const deriveTechTier = (antutuScore) => {
  const v = Number(antutuScore);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1_500_000) return "Luxurious";
  if (v >= 1_000_000) return "TechSavvy";
  if (v >= 700_000) return "FlagshipKiller";
  if (v >= 400_000) return "Reasonable";
  return "Budget";
};

// Pick the most-frequent value in `values`. Ties break toward the
// larger value (`>` not `>=`) so newer recommendations win when
// several buckets share the same count. Returns `null` on empty.
const mode = (values) => {
  const counts = new Map();
  for (const v of values) {
    if (v == null) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestVal = null;
  let bestCount = -1;
  for (const [val, count] of counts.entries()) {
    if (count > bestCount) {
      bestVal = val;
      bestCount = count;
    }
  }
  return bestVal;
};

// Run the aggregator for a single user. Idempotent, near-no-op when
// the inputs haven't moved enough to justify a refresh.
//
// Returns `{ updated: boolean, ... }` for tests / debugging. On
// `updated: false` no DB write happened — either the gate tripped
// or there was nothing to update. Errors are swallowed and logged
// so a transient DB blip can never break the recommendation flow.
export const aggregateUserProfile = async (userId) => {
  if (!userId) return { updated: false, reason: "no-user" };

  try {
    const [customer, latest] = await Promise.all([
      prisma.customerProfile.findUnique({
        where: { userId },
        select: { lastUpdated: true },
      }),
      prisma.recommendationHistory.findFirst({
        where: { userId },
        orderBy: { searchDate: "desc" },
        select: { searchDate: true },
      }),
    ]);

    if (!customer || !latest) {
      // No customer profile row yet (fresh user, no explicit prefs).
      // Nothing to aggregate.
      return { updated: false, reason: "no-profile" };
    }

    // Cheap gate — only refetch / rebuild if ≥ MIN_NEW_ROWS rows have
    // landed since the last refresh.
    const rowsSince = await prisma.recommendationHistory.count({
      where: {
        userId,
        searchDate: { gt: customer.lastUpdated },
      },
    });
    if (rowsSince < MIN_NEW_ROWS) {
      return { updated: false, reason: "below-threshold", rowsSince };
    }

    // Pull the last AGGREGATE_WINDOW phones referenced by this user's
    // recommendation history, joined to Phones + first variant.
    const recentRows = await prisma.recommendationHistory.findMany({
      where: { userId },
      orderBy: { searchDate: "desc" },
      take: AGGREGATE_WINDOW,
      select: {
        phoneId: true,
        phone: {
          select: {
            antutuScore: true,
            variants: {
              where: { isAvailable: true },
              orderBy: { price: "asc" },
              take: 1,
              select: { ramGb: true, storageGb: true },
            },
          },
        },
      },
    });

    const antutuScores = recentRows
      .map((r) => r.phone?.antutuScore)
      .filter((v) => v != null);
    const ramValues = recentRows
      .map((r) => r.phone?.variants?.[0]?.ramGb)
      .filter((v) => v != null);
    const storageValues = recentRows
      .map((r) => r.phone?.variants?.[0]?.storageGb)
      .filter((v) => v != null);

    const nextTier = deriveTechTier(mode(antutuScores));
    const nextRam = mode(ramValues);
    const nextStorage = mode(storageValues);

    // Skip if nothing has actually changed — keeps lastUpdated
    // jumping around for nothing.
    const existing = await prisma.customerProfile.findUnique({
      where: { userId },
      select: { techTier: true, preferredRamGb: true, preferredStorageGb: true },
    });

    const wantTier =
      nextTier && nextTier !== existing.techTier ? nextTier : undefined;
    const wantRam =
      nextRam != null && nextRam !== existing.preferredRamGb
        ? nextRam
        : undefined;
    const wantStorage =
      nextStorage != null && nextStorage !== existing.preferredStorageGb
        ? nextStorage
        : undefined;

    const updateData = {};
    if (wantTier) updateData.techTier = wantTier;
    if (wantRam != null) updateData.preferredRamGb = wantRam;
    if (wantStorage != null) updateData.preferredStorageGb = wantStorage;

    if (Object.keys(updateData).length === 0) {
      return { updated: false, reason: "unchanged" };
    }

    await prisma.customerProfile.update({
      where: { userId },
      data: updateData,
    });

    return { updated: true, ...updateData };
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profileAggregator] failed for user",
        userId,
        ":",
        err?.message || err,
      );
    } else {
      console.error("[profileAggregator] failed for user", userId, err);
    }
    return { updated: false, reason: "error" };
  }
};

// Fire-and-forget wrapper used by callers that don't want to await
// the aggregator. The half-minute gate (AGGREGATE_MIN_INTERVAL_MS) is
// enforced *across all calls in the same Node process* via an
// in-memory Map — sufficient for the single-instance BE we run in
// dev; in a multi-instance deployment this becomes per-instance
// throttling, which is fine since the aggregator itself is idempotent.
const inFlight = new Map();

export const safeAggregateAfterRecommendation = async (userId) => {
  if (!userId) return;
  const last = inFlight.get(userId) || 0;
  if (Date.now() - last < AGGREGATE_MIN_INTERVAL_MS) return;
  inFlight.set(userId, Date.now());

  // Don't await — caller is on the hot path.
  void aggregateUserProfile(userId).finally(() => {
    inFlight.set(userId, Date.now());
  });
};
