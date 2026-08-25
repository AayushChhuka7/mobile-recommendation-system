"""Recommendation engine — direct port of notebook cells 98-104.

`PersonaType` and `PERSONA_PRESETS` are verbatim from cell 98.
`UserPreferenceInput` is the dataclass the UI form / API fills in.
`recommend()` is the ranker from cell 104, lifted out of the notebook
global `df` and into a function that takes the candidate frame as an arg.

Constraint model
----------------

User-supplied inputs are split into two buckets:

  HARD constraints — enforced as absolute drop conditions. They are
    NEVER widened, NEVER removed by the ranker, and NEVER mutated by
    `recommend()`.
        • `Price_EUR <= budget.max`           (user's stated max is a hard ceiling)
        • `RAM_GB >= RAM_ABSOLUTE_FLOOR_GB`    (absolute usability floor)
        • `RAM_GB >= min_ram_gb`               (only if user explicitly set it)
        • `Has_5G == 1`                        (only if user explicitly required it)
        • `Storage_GB >= min_storage_gb`       (only if user explicitly set it)
        • Brand NOT in `exclude_brands`        (only if user explicitly excluded any)
        • Brand IS in `preferred_brands`       (only if user explicitly picked any)

  SOFT preferences — penalise the Match_Score but do not drop. They
    may be relaxed (penalty removed) when the hard-constrained pool
    is smaller than `MIN_CANDIDATES`.
        • Persona / feature weight sliders (drive the base score, not
          a filter — see `resolve_weights()`)

  Note on the brand-filter rework: `preferred_brands` used to live
  under SOFT (penalty + relaxable) and was promoted to HARD so the
  "Recommend Me a Phone" click flow respects the user's include
  choice as a require, not as a rank nudge. There are no longer any
  relaxable preferences — see `SOFT_RELAXATION_ORDER` (currently
  empty).

Why this split
--------------

Previously the ranker ran a single relaxation loop that progressively
widened `budget.max` by 40% per pass to satisfy `MIN_CANDIDATES`. That
silently violated the user's stated budget — a €500 user could end up
seeing €700 or €980 phones. The relaxation loop also widened RAM and
dropped 5G, which violates explicit mandatory requirements.

The new loop ONLY relaxes soft preferences. Hard constraints remain
exactly as the user specified them. If the hard-constrained pool is
too small, the ranker returns what it has; the BE surfaces a "fewer
than MIN_CANDIDATES" hint via `RelaxationLog` without ever changing
what the user typed.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Tuple, List, Dict, Any

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# 1. PERSONA PRESETS  (verbatim from cell 98)
# ---------------------------------------------------------------------------
PERSONA_PRESETS: Dict[str, Dict[str, float]] = {
    "Gamer": {
        "Gaming": 1.0, "Camera": 0.3, "Battery": 0.7,
        "Display": 0.8, "Software": 0.3, "Storage": 0.5,
        "Connectivity": 0.4, "Security": 0.2, "Portability": 0.2,
    },
    "Camera_Lover": {
        "Gaming": 0.3, "Camera": 1.0, "Battery": 0.5,
        "Display": 0.6, "Software": 0.4, "Storage": 0.6,
        "Connectivity": 0.3, "Security": 0.2, "Portability": 0.4,
    },
    "Battery_Focused": {
        "Gaming": 0.4, "Camera": 0.4, "Battery": 1.0,
        "Display": 0.4, "Software": 0.3, "Storage": 0.3,
        "Connectivity": 0.3, "Security": 0.2, "Portability": 0.5,
    },
    "All_Rounder": {
        "Gaming": 0.6, "Camera": 0.6, "Battery": 0.6,
        "Display": 0.6, "Software": 0.5, "Storage": 0.5,
        "Connectivity": 0.5, "Security": 0.4, "Portability": 0.4,
    },
    "Business_User": {
        "Gaming": 0.2, "Camera": 0.4, "Battery": 0.8,
        "Display": 0.5, "Software": 0.9, "Storage": 0.5,
        "Connectivity": 0.7, "Security": 0.9, "Portability": 0.6,
    },
}

SCORE_DIMENSIONS: List[str] = [
    "Gaming", "Camera", "Battery", "Display", "Software",
    "Storage", "Connectivity", "Security", "Portability",
]

# Output of `compute_scores` (cell 96) — column name per dimension.
score_cols_map: Dict[str, str] = {
    "Gaming": "Gaming_Score",
    "Camera": "Camera_Score",
    "Battery": "Battery_Score",
    "Display": "Display_Score",
    "Software": "Software_Score",
    "Storage": "Storage_Score",
    "Connectivity": "Connectivity_Score",
    "Security": "Security_Score",
    "Portability": "Portability_Score",
}


# ---------------------------------------------------------------------------
# Constraint tunables
# ---------------------------------------------------------------------------
# Penalty per unit of soft-preference violation, in score points
# (0..100). Higher = harsher penalty. Hard-constraint violations do
# NOT use this table — they drop the row outright.
#
# `price_penalty` (auto-flow soft price): the magnitude is the penalty
# PER UNIT of (price - budget_max_eur) / budget_max_eur, applied when
# the BE sets `soft_price=True` (auto-recommend). The formula is
# `price_penalty * max(0, (price - budget) / budget)`, capped at 95 so
# any single out-of-budget phone still gets a non-zero Match_Score.
# A phone at 1.1× the budget loses ~6 points; at 1.5× loses ~30; at
# 2.0× loses ~60; at 2.5×+ hits the cap.
SOFT_FILTER_WEIGHTS: Dict[str, float] = {
    "brand_penalty":        12.0,     # DEPRECATED — no caller; see note above.
    "price_penalty":        60.0,     # per unit (price/budget - 1) on auto flow.
}

# Absolute usability floors. These are hard drops, not soft penalties.
RAM_ABSOLUTE_FLOOR_GB = 4             # phones < 4GB RAM are dropped

# Minimum candidate set size before progressive relaxation kicks in.
# If the hard-constrained set is smaller than this we relax SOFT
# preferences only (in `SOFT_RELAXATION_ORDER`) until we have at least
# this many candidates (or we run out of relaxations). Hard constraints
# are NEVER relaxed to satisfy this floor — fewer-than-MIN_CANDIDATES
# is a valid outcome.
MIN_CANDIDATES = 10

# Order in which SOFT preferences are relaxed. Budget, RAM, 5G,
# storage, exclude_brands, and preferred_brands are NOT in this list
# because they are hard constraints — `recommend()` will never widen
# or remove them.
#
# As of the brand-filter rework, `preferred_brands` is a hard drop
# (see `_hard_filter_drops` step 7) rather than a soft preference, so
# this list is currently empty. Kept as a tuple so future soft
# preferences can be added without changing call sites.
SOFT_RELAXATION_ORDER: Tuple[str, ...] = ()


class PersonaType(str, Enum):
    GAMER = "Gamer"
    CAMERA_LOVER = "Camera_Lover"
    BATTERY_FOCUSED = "Battery_Focused"
    ALL_ROUNDER = "All_Rounder"
    BUSINESS_USER = "Business_User"
    CUSTOM = "Custom"


# ---------------------------------------------------------------------------
# 2. USER INPUT SCHEMA  (mirrors cell 98, with light field cleanup)
# ---------------------------------------------------------------------------
@dataclass
class UserPreferenceInput:
    # --- Required, HARD constraints (always enforced, never relaxed) ---
    budget_max_eur: float               # user-stated max — hard ceiling
    budget_min_eur: float = 0.0
    # When True, `budget_max_eur` is honoured as a SOFT penalty
    # instead of a hard drop (auto-recommend flow). Phones above the
    # user's stored maxBudget are still ranked, but with a reduced
    # `value` slot — the further above the budget, the bigger the
    # penalty. Default False preserves the click-flow hard-drop
    # contract. Set by the BE on the auto path (Dashboard mount).
    soft_price: bool = False

    # --- Persona quick-pick (drives default weights, soft) ---
    persona: PersonaType = PersonaType.ALL_ROUNDER

    # --- Optional HARD constraints ---
    # Each of these is treated as a hard drop condition if set.
    # They are NEVER widened or removed by the ranker.
    min_ram_gb: Optional[float] = None          # e.g. 12 — user explicitly required
    min_storage_gb: Optional[float] = None      # e.g. 256 — user explicitly required
    require_5g: bool = False                    # user explicitly required 5G
    require_purchasable: bool = False
    exclude_brands: Optional[List[str]] = None  # hard-excluded brands never appear

    # --- Optional SOFT preferences ---
    # Penalise ranking when violated. May be relaxed by the ranker when
    # the hard-constrained pool is smaller than `min_candidates`.
    preferred_brands: Optional[List[str]] = None

    # --- Custom weight overrides (soft, always honoured) ---
    # e.g. {"Battery": 5, "Software": 4}  -- 0-5 stars; only used if persona=CUSTOM
    custom_weights_stars: Optional[Dict[str, int]] = None

    # --- Output controls ---
    top_n_results: int = 5
    exclude_imputed_price: bool = True

    # --- Progressive relaxation controls ---
    min_candidates: int = MIN_CANDIDATES

    def resolve_weights(self) -> Dict[str, float]:
        """Return the dimension weights to use for ranking."""
        if self.persona == PersonaType.CUSTOM:
            assert self.custom_weights_stars, "Custom persona needs custom_weights_stars"
            # 0-5 stars → 0-1 scale, then renorm so min=0 not mandatory.
            base = {d: float(self.custom_weights_stars.get(d, 0)) / 5.0 for d in SCORE_DIMENSIONS}
        else:
            base = dict(PERSONA_PRESETS[self.persona.value])
        return base


# ---------------------------------------------------------------------------
# Hard / soft constraint split
# ---------------------------------------------------------------------------
def _hard_filter_drops(row, request: UserPreferenceInput) -> bool:
    """Return True when the row violates a HARD constraint and must be
    dropped outright.

    Hard constraints are NEVER relaxed or widened by the ranker. The
    user's `budget.max`, explicit RAM/storage/5G requirements, the
    absolute 4 GB RAM usability floor, `exclude_brands`, and
    `preferred_brands` (include-list) all live here.

    Note on `preferred_brands`: as of the "Recommend Me a Phone"
    brand-filter rework, an include-list (mode=include in the FE
    "Find your phone" modal) is also a hard drop, not a soft penalty.
    A non-preferred brand never enters the candidate pool — same
    semantics as `exclude_brands` but inverted. The old SOFT path
    (`_soft_filter_drops`) and the `brand_preference` relaxation step
    still exist as a no-op safety net so a caller that sets
    `preferred_brands` but expects the legacy penalty behaviour
    doesn't break — `_soft_filter_drops` simply returns False for the
    brand-preference case now.
    """
    # 1. Budget ceiling — user-stated max is the hard cap. Any phone
    #    priced strictly above `budget_max_eur` is dropped. The previous
    #    2× "trust floor" has been removed; the user's own ceiling is
    #    now the only price constraint.
    #
    #    Auto-recommend (BE sets `soft_price=True`) opts out of this
    #    hard drop. Out-of-budget phones stay in the candidate pool;
    #    `_soft_filter_penalty` reduces their Match_Score proportionally
    #    to how far over-budget they are. The user's ceiling is still
    #    visible in the result — just as a ranking signal, not a wall.
    price = float(row.get("Price_EUR", 0) or 0)
    if not request.soft_price and price > request.budget_max_eur:
        return True

    # 2. Absolute RAM usability floor (always enforced).
    if "RAM_GB" in row.index:
        ram = float(row.get("RAM_GB", 0) or 0)
        if ram < RAM_ABSOLUTE_FLOOR_GB:
            return True

    # 3. Explicit minimum RAM (only if user set it).
    if request.min_ram_gb is not None and "RAM_GB" in row.index:
        ram = float(row.get("RAM_GB", 0) or 0)
        if ram < request.min_ram_gb:
            return True

    # 4. Explicit minimum storage (only if user set it).
    if request.min_storage_gb is not None and "Storage_GB" in row.index:
        storage = float(row.get("Storage_GB", 0) or 0)
        if storage < request.min_storage_gb:
            return True

    # 5. Explicit 5G requirement.
    if request.require_5g and "Has_5G" in row.index:
        if int(row.get("Has_5G", 0) or 0) != 1:
            return True

    # 6. Excluded brands (hard exclusion — the user asked to never
    #    see these).
    if request.exclude_brands and "Brand" in row.index:
        brand = str(row.get("Brand", "") or "")
        if brand in request.exclude_brands:
            return True

    # 7. Preferred brands (include-list — FE "Find your phone" modal
    #    with mode=include). A non-listed brand is hard-dropped so the
    #    user only ever sees phones from the brands they explicitly
    #    picked. Empty list is treated as "no constraint" (any brand
    #    passes) — same as the legacy soft path.
    if request.preferred_brands and "Brand" in row.index:
        brand = str(row.get("Brand", "") or "")
        if brand not in request.preferred_brands:
            return True

    return False


def _soft_filter_drops(
    row,
    request: UserPreferenceInput,
    brand_preference_active: bool,
) -> bool:
    """Return True when a SOFT preference filters the row out of the
    candidate pool.

    As of the brand-filter rework, no SOFT preference drops a row
    outright anymore — `preferred_brands` was promoted to a HARD
    drop in `_hard_filter_drops` (step 7) so the user's include-list
    is always honoured. The `brand_preference_active` flag and this
    function are kept for backward compatibility with the relaxation
    loop (which is now a no-op, see `SOFT_RELAXATION_ORDER`). The
    arguments remain so future soft preferences can be added without
    touching call sites.
    """
    _ = (row, request, brand_preference_active)  # currently unused
    return False


def _soft_filter_penalty(
    row,
    request: UserPreferenceInput,
    brand_preference_active: bool,
) -> float:
    """Return the SOFT penalty to subtract from Match_Score (points 0..100).

    A non-zero value here is purely a ranking signal — it never drops
    a row. Brand drops (when active) are handled by
    `_soft_filter_drops`; this function is reserved for soft
    preferences that only adjust rank without removing candidates.

    Active soft preferences today:
      - Auto-flow price penalty (request.soft_price=True). Out-of-budget
        phones pay `SOFT_FILTER_WEIGHTS["price_penalty"]` per unit of
        (price - budget) / budget. A phone at 1.5× budget loses ~30
        points; at 2× loses ~60. Capped at 95 so a wildly overpriced
        phone still has a non-zero Match_Score.

    Brand-preference violations are hard drops in `_hard_filter_drops`,
    so this function never returns a non-zero value for that case.
    The cap at 95 keeps any single violating dimension from
    collapsing a candidate's Match_Score below 5%.
    """
    _ = brand_preference_active  # reserved for future soft preferences

    # Auto-flow soft price: only when the BE explicitly opts in. The
    # click path keeps the hard-drop semantics (`_hard_filter_drops`
    # step 1), so this branch is a no-op for `/recommend` from the
    # "Recommend Me a Phone" button.
    if request.soft_price and "Price_EUR" in row.index:
        price = float(row.get("Price_EUR", 0) or 0)
        budget = float(request.budget_max_eur or 0)
        if budget > 0 and price > budget:
            # Per-unit penalty scaled by fractional overshoot. The
            # cap at 95 means even a phone at 2.6× budget keeps ~5%
            # Match_Score — visible, not buried.
            overshoot = (price - budget) / budget
            penalty = SOFT_FILTER_WEIGHTS["price_penalty"] * overshoot
            return min(95.0, penalty)
    return 0.0


# ---------------------------------------------------------------------------
# Soft-preference relaxation
# ---------------------------------------------------------------------------
def _apply_next_soft_relaxation(
    request: UserPreferenceInput,
    already: Tuple[str, ...],
    brand_preference_active: bool,
) -> Optional[str]:
    """Return the name of the next soft preference to relax, or None.

    This function NEVER mutates `request`. The caller owns the
    `brand_preference_active` flag and flips it when the brand step
    fires. Hard constraints (budget.max, min_ram_gb, min_storage_gb,
    require_5g, exclude_brands) are not in `SOFT_RELAXATION_ORDER`
    and therefore cannot be relaxed by this function — they remain
    exactly as the user specified them.
    """
    for step in SOFT_RELAXATION_ORDER:
        if step in already:
            continue
        if step == "brand_preference":
            if request.preferred_brands is not None and brand_preference_active:
                return "brand_preference"
            continue
    return None


# ---------------------------------------------------------------------------
# 3. THE RANKER  (cell 104 logic + hard/soft constraint split)
# ---------------------------------------------------------------------------
def recommend(
    df: pd.DataFrame,
    request: UserPreferenceInput,
    score_cols_map_: Optional[Dict[str, str]] = None,
    exclude_imputed_price: bool = True,
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Filter + rank phones by persona weights, with hard/soft constraint split.

    Returns (results, error). `results` is None when no candidate
    survives the hard constraints. The function NEVER widens
    `budget.max`, NEVER drops an explicit 5G / RAM / storage /
    exclude-brand requirement, and NEVER violates any other
    user-stated hard constraint to satisfy `min_candidates`.
    """
    if score_cols_map_ is None:
        score_cols_map_ = score_cols_map

    weights = request.resolve_weights()
    weight_sum = sum(weights.values()) or 1.0

    # Snapshot the user-stated budget so we can return it on every
    # result entry, regardless of any future relaxation. The
    # relaxation loop never writes back to this snapshot — it is
    # read-only from `recommend()`'s perspective.
    original_budget_max = float(request.budget_max_eur)

    # 1. Initial pool — exclude imputed prices and non-purchasable
    #    rows. Both are data-quality filters, not user constraints.
    candidates = df.copy()
    if exclude_imputed_price and "Price_EUR_is_imputed" in candidates.columns:
        candidates = candidates[candidates["Price_EUR_is_imputed"] == False]  # noqa: E712
    if request.require_purchasable and "Is_Purchasable" in candidates.columns:
        candidates = candidates[candidates["Is_Purchasable"] == 1]

    # 2. Compute the raw persona-weighted Match_Score on the full pool.
    match_score = pd.Series(0.0, index=candidates.index)
    for dim, w in weights.items():
        match_score = match_score + candidates[score_cols_map_[dim]] * w
    match_score = match_score / weight_sum

    # 3. Hard drop pass — anything violating a hard constraint leaves
    #    the pool. `request` is NOT mutated.
    rows_to_drop: List[Any] = []
    for idx in candidates.index:
        if _hard_filter_drops(candidates.loc[idx], request):
            rows_to_drop.append(idx)
    if rows_to_drop:
        candidates = candidates.drop(index=rows_to_drop)
        match_score = match_score.drop(index=rows_to_drop)

    # 4. Soft-preference relaxation loop. Only `brand_preference`
    #    is relaxable today. Hard constraints are never touched.
    relaxation_log: List[str] = []
    brand_preference_active = bool(
        request.preferred_brands and len(request.preferred_brands) > 0
    )

    # 3b. Soft drop pass — brand preference drops non-preferred rows
    #    from the pool when active. The relaxation loop may turn this
    #    filter off (via `brand_preference_active`) to re-include those
    #    rows when the filtered pool is too small.
    if not candidates.empty:
        soft_drop_rows: List[Any] = []
        for idx in candidates.index:
            if _soft_filter_drops(
                candidates.loc[idx], request, brand_preference_active
            ):
                soft_drop_rows.append(idx)
        if soft_drop_rows:
            candidates = candidates.drop(index=soft_drop_rows)
            match_score = match_score.drop(index=soft_drop_rows)

    # Apply the soft penalty with the live preference state, then
    # dedup + sort. We re-run this block after each relaxation step
    # so the rank reflects the post-relaxation preference set.
    def _apply_soft_and_dedup() -> None:
        if candidates.empty:
            return
        # Reset match_score to the base (pre-soft) for every row that
        # is still in the pool, then re-subtract the current soft
        # penalty. We rebuild the base by re-running the persona
        # weighting — the base columns are unchanged, so this is cheap.
        nonlocal match_score
        base = pd.Series(0.0, index=candidates.index)
        for dim, w in weights.items():
            base = base + candidates[score_cols_map_[dim]] * w
        base = base / weight_sum
        for idx in candidates.index:
            soft = _soft_filter_penalty(
                candidates.loc[idx], request, brand_preference_active
            )
            base[idx] = max(0.0, base[idx] - soft)
        match_score = base

    _apply_soft_and_dedup()

    if not candidates.empty:
        candidates = candidates.assign(Match_Score=match_score)
        candidates = (
            candidates.sort_values(
                ["Match_Score", "Price_EUR"], ascending=[False, True]
            ).drop_duplicates(subset=["Brand", "Model_Name"], keep="first")
        )

    # Relax soft preferences if the hard-constrained pool is too small.
    while len(candidates) < request.min_candidates:
        relaxed = _apply_next_soft_relaxation(
            request, tuple(relaxation_log), brand_preference_active
        )
        if not relaxed:
            break
        relaxation_log.append(relaxed)
        if relaxed == "brand_preference":
            brand_preference_active = False
            # Re-include the rows that the brand preference had
            # dropped. We re-apply hard drops on the FULL `df` so
            # candidates = hard_filter(full_df) again.
            full_pool = df.copy()
            if (
                exclude_imputed_price
                and "Price_EUR_is_imputed" in full_pool.columns
            ):
                full_pool = full_pool[
                    full_pool["Price_EUR_is_imputed"] == False  # noqa: E712
                ]
            if (
                request.require_purchasable
                and "Is_Purchasable" in full_pool.columns
            ):
                full_pool = full_pool[full_pool["Is_Purchasable"] == 1]
            base_full = pd.Series(0.0, index=full_pool.index)
            for dim, w in weights.items():
                base_full = base_full + full_pool[score_cols_map_[dim]] * w
            base_full = base_full / weight_sum
            rows_to_drop = []
            for idx in full_pool.index:
                if _hard_filter_drops(full_pool.loc[idx], request):
                    rows_to_drop.append(idx)
            if rows_to_drop:
                full_pool = full_pool.drop(index=rows_to_drop)
                base_full = base_full.drop(index=rows_to_drop)
            candidates = full_pool
            match_score = base_full
        _apply_soft_and_dedup()
        if not candidates.empty:
            candidates = candidates.assign(Match_Score=match_score)
            candidates = (
                candidates.sort_values(
                    ["Match_Score", "Price_EUR"], ascending=[False, True]
                ).drop_duplicates(subset=["Brand", "Model_Name"], keep="first")
            )
        if len(relaxation_log) >= len(SOFT_RELAXATION_ORDER):
            break

    # 5. Empty-pool early exit — never synthesise candidates, never
    #    widen the budget. The BE surfaces this error message verbatim.
    if candidates.empty:
        return (
            None,
            "No phones match your hard constraints — try widening your budget "
            "or relaxing a hard requirement.",
        )

    # 6. Top-N by Match_Score desc.
    candidates = candidates.assign(Match_Score=match_score.round(1))
    top = candidates.sort_values(
        "Match_Score", ascending=False
    ).head(request.top_n_results)

    avg_scores = {dim: float(candidates[score_cols_map_[dim]].mean()) for dim in weights}

    results: List[Dict[str, Any]] = []
    for _, phone in top.iterrows():
        reasons = []
        for dim, w in sorted(weights.items(), key=lambda x: -x[1]):
            gap = float(phone[score_cols_map_[dim]] - avg_scores[dim])
            if gap > 5:
                reasons.append(f"{dim} strong (+{gap:.0f} vs avg)")
        results.append(
            {
                "Brand": phone["Brand"],
                "Model": phone["Model_Name"],
                "Price_EUR": round(float(phone["Price_EUR"]), 2),
                "Match_Score": float(phone["Match_Score"]),
                "Why": reasons[:4],
                "Overall_Score": round(float(phone["Overall_Score"]), 2),
                "Value_Score": round(float(phone["Value_Score"]), 2),
                "SubScores": {
                    dim: round(float(phone[score_cols_map_[dim]]), 2)
                    for dim in SCORE_DIMENSIONS
                },
                # Soft-relaxation log. Lists the soft preferences the
                # ranker turned off because the hard-constrained pool
                # was below `min_candidates`. NEVER contains a hard
                # constraint, and NEVER contains `price_band` / `ram` /
                # `5g` / `storage` — those are not relaxable.
                "RelaxationLog": list(relaxation_log),
                # EffectiveBudgetMax — always the user-supplied budget
                # cap. Kept in the response for diagnostic continuity;
                # it is no longer the artifact of any widening.
                "EffectiveBudgetMax": round(original_budget_max, 2),
            }
        )
    return results, None
