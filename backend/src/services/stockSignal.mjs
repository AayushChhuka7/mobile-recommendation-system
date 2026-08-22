// stockSignal — pre-fusion stock gate and freshness/trending read for
// the auto-recommendation pipeline.
//
// Pre-fusion gate (Fix #9):
//   - Out-of-stock phones are DROPPED from auto responses (the user
//     didn't ask for them; we shouldn't show phones they can't buy).
//   - Low-stock phones are KEPT and PENALISED via a small multiplier
//     applied at rank time. The pre-fusion gate is binary.
//
// Trend / freshness read:
//   - trendScore   from `phone_trends` (populated nightly), 0..1.
//   - daysSinceRelease from `phones.releasedAt`, clamped to 540 days.
//
// All reads are best-effort. A failure here MUST NOT block the
// recommendation response; we return the empty/default shape.

import { prisma } from "../config/prisma.mjs";

const MAX_AGE_DAYS = 540;
const FRESHNESS_HALF_LIFE_DAYS = 180;
const STOCK_PENALTY = 0.85; // 15% final-score multiplier on low_stock

// Pre-fusion stock gate. Returns:
//   { keep: boolean, stockPenalty: number }
// where stockPenalty is the multiplier to apply to finalScore at rank
// time. `keep: false` means drop the candidate outright.
//
// Default `stockState = null` is treated as "in_stock" — we don't
// want unknown stock to drop phones that have always worked.
export function stockGate(phone) {
  const state = (phone && typeof phone.stockState === "string"
    ? phone.stockState.toLowerCase()
    : "in_stock");
  if (state === "out_of_stock") return { keep: false, stockPenalty: 1.0 };
  if (state === "low_stock")    return { keep: true,  stockPenalty: STOCK_PENALTY };
  return { keep: true, stockPenalty: 1.0 };
}

// Compute the freshness sub-score for a phone, in [0, 1].
//
//   freshness = 0.5 ^ (ageDays / HALF_LIFE)
//
// Half-life 180d means a brand-new phone scores 1.0, a 1-year-old
// phone scores 0.5, a 2-year-old phone scores 0.25, and a 3+-year-
// old phone plateaus near 0 (clamped at 0).
//
// Returns 0.5 (neutral) when `releasedAt` is missing — the legacy
// `freshness_trending` slot must never DROP a phone just because we
// don't know when it was released.
export function freshnessScore(phone) {
  if (!phone || !phone.releasedAt) return 0.5;
  const releasedAt =
    phone.releasedAt instanceof Date
      ? phone.releasedAt
      : new Date(phone.releasedAt);
  if (Number.isNaN(releasedAt.getTime())) return 0.5;
  const now = Date.now();
  const ageDays = Math.max(0, Math.min(MAX_AGE_DAYS,
    (now - releasedAt.getTime()) / (1000 * 60 * 60 * 24),
  ));
  return Math.max(0, Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS));
}

// Batch read trend + freshness for a list of phoneIds. Returns
// Map<phoneId, { trendScore, freshness, stockState, stockPenalty }>.
// Empty Map on failure.
export async function loadStockAndTrend(phoneIds) {
  const out = new Map();
  if (!Array.isArray(phoneIds) || phoneIds.length === 0) return out;

  const ids = Array.from(
    new Set(phoneIds.filter((id) => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) return out;

  try {
    const rows = await prisma.phones.findMany({
      where: { phoneId: { in: ids } },
      select: {
        phoneId: true,
        releasedAt: true,
        stockState: true,
        trend: { select: { trendScore: true } },
      },
    });
    for (const r of rows) {
      out.set(r.phoneId, {
        trendScore: r.trend?.trendScore ?? 0,
        freshness: freshnessScore({ releasedAt: r.releasedAt }),
        stockState: r.stockState || "in_stock",
        stockPenalty: stockGate({ stockState: r.stockState }).stockPenalty,
      });
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[stockSignal] loadStockAndTrend failed:",
        err?.message || err,
      );
    } else {
      console.error("[stockSignal] loadStockAndTrend failed:", err);
    }
    return out;
  }
}

// Apply a stockPenalty to a finalScore in [0, 1]. Clamped to [0, 1].
export function applyStockPenalty(finalScore, stockPenalty) {
  if (!Number.isFinite(finalScore)) return 0;
  if (!Number.isFinite(stockPenalty) || stockPenalty >= 1) return finalScore;
  if (stockPenalty <= 0) return 0;
  return Math.max(0, Math.min(1, finalScore * stockPenalty));
}
