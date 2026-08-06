// profileAggregator — re-derives the modal customer-profile knobs
// (techTier, preferredRamGb, preferredStorageGb) from the user's most
// recent recommendation rows.
//
// Why this lives in its own service:
//   The Step B behaviour events only touch the per-tag `BehaviorScore`
//   table; they don't carry the per-customer modal signals Step A
//   never asked about (RAM, storage, "tech sophistication"). When a
//   recommendation comes back, we have all the per-candidate phones
//   with modelName + brand + (via Phones) AnTuTu / RAM / storage. We
//   roll those up here so the admin panel — and any future
//   Step A feature that wants to nudge user preferences back from
//   observed behaviour — can read a single deterministic summary
//   without re-aggregating every time.
//
// When to call:
//   `safeRecordRecommendationEvent` in profileService.mjs calls
//   `safeAggregateAfterRecommendation(userId)` immediately after a
//   recommendation is persisted. The call is fire-and-forget — a
//   failure here must NEVER break the recommendation response the user
//   already received.
//
// Failure policy:
//   Every public entry point swallows its own errors and writes them
//   to the server log. The recommendation response is already in
//   flight by the time we run, so we can't 500 the user; we just
//   leave the prior aggregate values in place and continue.
//
// Throttling:
//   `safeAggregateAfterRecommendation` checks the user's most recent
//   RecommendationHistory row vs `lastAggregatedAt`. If fewer than
//   `MIN_NEW_ROWS` rows have been added since the last run, we skip
//   the work. This avoids re-aggregating on every recommendation call
//   when the data hasn't changed enough to matter.

import { prisma } from "../config/prisma.mjs";

// ---- Tunables --------------------------------------------------------------
//
// Number of recent recommendation rows we sample to derive the
// modal customer profile. 25 lines up with the "last 25 phones the
// customer saw" idea documented in profileService.
const AGGREGATE_WINDOW = 25;

// Skip the aggregate if the prior run happened within this many
// milliseconds AND fewer than MIN_NEW_ROWS rows have been added since.
const AGGREGATE_THROTTLE_MS = 60 * 1000;

// Minimum new rows before we re-aggregate. With a 4 % match threshold
// the rolling modal rarely shifts within 5 rows, so we skip the
// recompute rather than spend 5–10 ms on no-op aggregation.
const MIN_NEW_ROWS = 5;

// AnTuTu thresholds for the modal `TechTier` enum. The names come
// straight from the schema:
//   enum TechTier { Budget  Reasonable  FlagshipKiller  TechSavvy  Luxurious }
//
// Numbers are AnTuTu v10 totals rounded to the nearest hundred
// thousand. We pick the modal (most-common) tier from the sampled
// rows so a single extreme phone doesn't pull the user into
// "Luxurious" territory.
const TECH_TIER_BANDS = [
  { tier: "Luxurious", minAnutu: 1_500_000 },
  { tier: "TechSavvy", minAnutu: 1_000_000 },
  { tier: "FlagshipKiller", minAnutu: 700_000 },
  { tier: "Reasonable", minAnutu: 400_000 },
  { tier: "Budget", minAnutu: 0 },
];

// ---- Pure helpers ----------------------------------------------------------

// Classify a single phone's AnTuTu score into the nearest `TechTier`
// band. Returns null for non-finite input (caller drops the row).
export function deriveTechTier(antutuScore) {
  if (!Number.isFinite(antutuScore)) return null;
  for (const { tier, minAnutu } of TECH_TIER_BANDS) {
    if (antutuScore >= minAnutu) return tier;
  }
  return "Budget";
}

// Modal of a 1D array. Returns the most-frequent value, ties broken
// by first-encountered. Pure — no DB. Exported for tests.
export function mode(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const counts = new Map();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = -1;
  for (const [v, c] of counts.entries()) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// Median of a 1D array of numbers. Returns null for empty input.
// Pure — no DB. Exported for tests.
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const nums = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

// ---- DB-shape helpers ------------------------------------------------------

// Read the user's last `AGGREGATE_WINDOW` recommendation rows joined
// against Phones so we have modelName, brand, AnTuTu, and the
// per-variant RAM / storage. Returns null on a read failure so the
// caller can fall back to "no work to do".
async function loadRecentRecommendations(userId) {
  if (!userId) return null;
  try {
    const rows = await prisma.recommendationHistory.findMany({
      where: { userId },
      orderBy: { searchDate: "desc" },
      take: AGGREGATE_WINDOW,
      select: {
        historyId: true,
        searchDate: true,
        phone: {
          select: {
            antutuScore: true,
            variants: {
              select: { ramGb: true, storageGb: true },
            },
          },
        },
      },
    });
    return rows;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profileAggregator] loadRecentRecommendations failed:",
        err?.message || err,
      );
    } else {
      console.warn(
        "[profileAggregator] loadRecentRecommendations failed:",
        err,
      );
    }
    return null;
  }
}

// Compute the recommended CustomerProfile updates from the sampled
// rows. Returns null when there's not enough data to make a
// meaningful update — the caller then leaves the prior values in
// place. Pure (modulo the input rows).
function computeAggregateUpdate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Modal TechTier from each row's phone AnTuTu band.
  const tiers = [];
  const ramValues = [];
  const storageValues = [];

  for (const row of rows) {
    const tier = deriveTechTier(row.phone?.antutuScore);
    if (tier) tiers.push(tier);

    // Variants is a 1:N relation; pick the smallest RAM / storage
    // offered. "Minimum acceptable" is the strongest signal of what
    // the user has actively accepted. If we used the median we'd
    // drag premium configs up — but the user just *saw* those in a
    // recommendation list, not a purchase decision.
    const variants = row.phone?.variants || [];
    if (variants.length > 0) {
      const r = Math.min(...variants.map((v) => Number(v.ramGb)).filter(Number.isFinite));
      const s = Math.min(
        ...variants.map((v) => Number(v.storageGb)).filter(Number.isFinite),
      );
      if (Number.isFinite(r)) ramValues.push(r);
      if (Number.isFinite(s)) storageValues.push(s);
    }
  }

  const techTier = mode(tiers);
  const preferredRamGb = median(ramValues);
  const preferredStorageGb = median(storageValues);

  // Require at least 3 distinct AnTuTu observations to declare a tier,
  // otherwise we'd flip-flop between Budget ↔ Reasonable on a single
  // row. Same for RAM / storage medians.
  const tierVotes = tiers.length;
  const updates = {};

  if (techTier && tierVotes >= 3) {
    updates.techTier = techTier;
  }
  if (preferredRamGb != null && ramValues.length >= 3) {
    updates.preferredRamGb = Math.round(preferredRamGb);
  }
  if (preferredStorageGb != null && storageValues.length >= 3) {
    updates.preferredStorageGb = Math.round(preferredStorageGb);
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

// ---- Public API ------------------------------------------------------------

// Fire-and-forget after a recommendation call. Self-throttles: if
// fewer than `MIN_NEW_ROWS` rows have been added since the last
// `lastAggregatedAt`, we skip the read+write. Otherwise we re-derive
// the modal customer profile and write it back to CustomerProfile.
export async function safeAggregateAfterRecommendation(userId) {
  if (!userId) return;

  // Cheap throttle: read the user's CustomerProfile and check whether
  // enough new rows have come in since the last aggregation. If not,
  // skip the work.
  try {
    const [profile, rowCount] = await Promise.all([
      prisma.customerProfile.findUnique({
        where: { userId },
        select: { lastAggregatedAt: true },
      }),
      prisma.recommendationHistory.count({ where: { userId } }),
    ]);

    const last = profile?.lastAggregatedAt;
    if (last) {
      const elapsed = Date.now() - new Date(last).getTime();
      if (elapsed < AGGREGATE_THROTTLE_MS && rowCount < MIN_NEW_ROWS) {
        return;
      }
    }
  } catch (err) {
    // Throttle check failed — proceed with the work anyway. The
    // aggregator is idempotent so a redundant recompute is harmless.
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profileAggregator] throttle check failed:",
        err?.message || err,
      );
    } else {
      console.warn("[profileAggregator] throttle check failed:", err);
    }
  }

  try {
    const rows = await loadRecentRecommendations(userId);
    if (!rows || rows.length === 0) return;

    const updates = computeAggregateUpdate(rows);
    if (!updates) return;

    await prisma.customerProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...updates,
        lastAggregatedAt: new Date(),
        searchCount: 0,
        totalRecommendations: 0,
        totalComparisons: 0,
        segmentConfidence: "provisional",
      },
      update: {
        ...updates,
        lastAggregatedAt: new Date(),
      },
    });
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[profileAggregator] safeAggregateAfterRecommendation failed:",
        err?.message || err,
      );
    } else {
      console.warn(
        "[profileAggregator] safeAggregateAfterRecommendation failed:",
        err,
      );
    }
  }
}

// Re-export `deriveTechTier` for legacy callers that need the modal
// classifier directly (e.g. unit tests, future dashboards).
export { deriveTechTier as __deriveTechTier };
