/**
 * Display-layer price formatting.
 *
 * Backend prices are stored in EUR. The UI presents them in NPR at a
 * fixed conversion rate, rounded to the nearest 5 so the badge stays
 * neat (e.g. 58.5 EUR → 10179 NPR → 10180; 9.95 EUR → 1731 → 1730).
 *
 * `formatPriceNpr(price)`:
 *   - returns `null` for missing / non-positive values (callers decide
 *     what to render — em-dash, "Free", etc.)
 *   - returns a localised string with the `Rs` prefix
 *
 * `roundToNearest5(n)` is exported separately so tests / other display
 * paths can reuse the rounding rule without re-deriving the constant.
 */

// 1 EUR = 174 NPR — single source of truth for the conversion rate.
const EUR_TO_NPR = 174;

// Snap a positive integer to the nearest 5. `Math.round` already rounds
// halves up, so 2.5 → 5, 7.5 → 10, etc. We also clamp negatives and
// non-finite values to 0 so a corrupt payload can't print "-Rs 15".
export function roundToNearest5(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 5) * 5;
}

export function formatPriceNpr(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const npr = roundToNearest5(n * EUR_TO_NPR);
  return `Rs ${npr.toLocaleString()}`;
}
