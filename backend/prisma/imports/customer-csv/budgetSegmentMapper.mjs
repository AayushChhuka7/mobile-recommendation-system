// ---------------------------------------------------------------------------
// Best-effort mapper from CSV `preferred_category` values to the existing
// BudgetSegment enum.
//
// The CSV vocabulary ("Budget", "Mid-range", "Flagship", "Gaming",
// "Battery-focused", "Foldable", "Compact Phones", "5G Phones",
// "Premium Mid-range") is NOT the same axis as BudgetSegment (a price tier).
// We map what is meaningful, leave the rest unmapped, and log the unmapped
// values so a human can refine the mapping later.
//
// Mapping rationale:
//   - "Budget"           → BudgetExplorer  (clear price match)
//   - "Mid-range"        → MidRangeBuyer   (clear price match)
//   - "Premium Mid-range"→ PremiumBuyer    (closest price tier above mid)
//   - "Flagship"         → LuxuryBuyer     (the top price tier; there is no
//                                          direct Flagship budget segment,
//                                          so we use the top of the range)
//   - "5G Phones" / "Foldable" / "Compact Phones" / "Gaming" /
//     "Battery-focused" → NULL  (these are feature/category descriptors,
//                                 not price tiers; we don't lie about the
//                                 segment)
//
// Future refinement: add a `category_segment` enum if these become
// first-class signals. For now, NULL is the honest answer.
// ---------------------------------------------------------------------------

/**
 * @typedef {Record<string,string>} SegmentMapStats
 * Counts of how many rows hit each branch (for the final report).
 */

/** @type {Record<string, import("@prisma/client").BudgetSegment>} */
const PRICE_TIER_MAP = {
  budget: "BudgetExplorer",
  "mid-range": "MidRangeBuyer",
  "premium mid-range": "PremiumBuyer",
  flagship: "LuxuryBuyer",
};

/**
 * Map a raw CSV preferred_category string to a BudgetSegment enum value.
 * Returns `null` when no safe mapping exists.
 *
 * Side effect: mutates `stats` (counts of mapped vs unmapped).
 *
 * @param {string|null|undefined} raw
 * @param {SegmentMapStats} [stats]
 * @returns {import("@prisma/client").BudgetSegment|null}
 */
export function mapBudgetSegment(raw, stats) {
  if (raw == null) {
    if (stats) stats.skipped += 1;
    return null;
  }
  const key = String(raw).trim().toLowerCase();
  if (key === "") {
    if (stats) stats.skipped += 1;
    return null;
  }
  const mapped = PRICE_TIER_MAP[key];
  if (mapped) {
    if (stats) {
      stats.mapped += 1;
      stats.byValue[key] = (stats.byValue[key] ?? 0) + 1;
    }
    return /** @type {any} */ (mapped);
  }
  if (stats) {
    stats.skipped += 1;
    stats.unmappedValues[key] = (stats.unmappedValues[key] ?? 0) + 1;
  }
  return null;
}

/** Initialize a fresh stats object. */
export function newSegmentStats() {
  return { mapped: 0, skipped: 0, byValue: {}, unmappedValues: {} };
}
