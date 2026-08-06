/**
 * Display-layer price formatting.
 *
 * Backend prices are stored in EUR. The UI presents them in NPR. The
 * conversion is intentionally asymmetric so a user-facing budget that's
 * "round in NPR" maps back to a stable EUR value for the BE.
 *
 *   - Display: 1 EUR = 175 NPR  (×175, then snap to the nearest 0/5)
 *   - Input:   NPR → EUR by ÷174 (so a 174,000 NPR budget becomes
 *              exactly 1,000 EUR — no drift across the round trip)
 *
 * Rounding: after EUR→NPR multiplication, snap to the nearest multiple
 * of 5. This means every displayed NPR price ends in 0 or 5 (e.g.
 * 17124 → 17125, 3503 → 3505), keeping the badge neat across the
 * entire catalog.
 *
 * `formatPriceNpr(price)`:
 *   - returns `null` for missing / non-positive values (callers decide
 *     what to render — em-dash, "Free", etc.)
 *   - returns a localised string with the `Rs` prefix
 *
 * `roundToNearest5(n)` is exported separately so tests / other display
 * paths can reuse the rounding rule without re-deriving the constant.
 *
 * `eurFromNpr(npr)` is the inverse — used right before sending a
 * budget the user typed (in NPR) to the BE, which stores everything
 * in EUR. Two decimal places so the `roundToNearest5` snap doesn't
 * leak sub-NPR precision into the BE.
 *
 * Returns `null` for missing / non-finite values so callers can
 * silently skip the field instead of sending `NaN`.
 */

// 1 EUR = 175 NPR — single source of truth for the display conversion.
const EUR_TO_NPR = 175;

// 1 EUR = 174 NPR — single source of truth for the reverse
// (user-typed NPR → backend EUR). Different from `EUR_TO_NPR` on
// purpose: dividing by 174 (not 175) keeps a 174,000 NPR budget
// perfectly stable when bouncing through the BE.
const NPR_PER_EUR_INPUT = 174;

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

export function eurFromNpr(npr) {
  const n = Number(npr);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / NPR_PER_EUR_INPUT) * 100) / 100;
}