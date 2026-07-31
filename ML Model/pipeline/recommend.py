"""Recommendation engine — direct port of notebook cells 98-104.

`PersonaType` and `PERSONA_PRESETS` are verbatim from cell 98.
`UserPreferenceInput` is the dataclass the UI form / API fills in.
`recommend()` is the ranker from cell 104, lifted out of the notebook
global `df` and into a function that takes the candidate frame as an arg.
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
    # --- Required, hard filters (applied BEFORE any scoring) ---
    budget_max_eur: float
    budget_min_eur: float = 0.0

    # --- Persona quick-pick (drives default weights) ---
    persona: PersonaType = PersonaType.ALL_ROUNDER

    # --- Optional hard filters ---
    preferred_brands: Optional[List[str]] = None        # e.g. ["Samsung", "OnePlus"]
    exclude_brands: Optional[List[str]] = None
    min_ram_gb: Optional[float] = None
    require_5g: bool = False
    require_purchasable: bool = False

    # --- Custom weight overrides ---
    # e.g. {"Battery": 5, "Software": 4}  -- 0-5 stars; only used if persona=CUSTOM
    custom_weights_stars: Optional[Dict[str, int]] = None

    # --- Output controls ---
    top_n_results: int = 5
    exclude_imputed_price: bool = True

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
# 3. THE RANKER  (verbatim logic from cell 104, lifted to a function)
# ---------------------------------------------------------------------------
def recommend(
    df: pd.DataFrame,
    request: UserPreferenceInput,
    score_cols_map_: Optional[Dict[str, str]] = None,
    exclude_imputed_price: bool = True,
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Filter + rank phones by persona weights.

    Returns (results, error).  results is None if no candidates match.
    """
    if score_cols_map_ is None:
        score_cols_map_ = score_cols_map

    weights = request.resolve_weights()

    candidates = df.copy()
    if exclude_imputed_price and "Price_EUR_is_imputed" in candidates.columns:
        candidates = candidates[candidates["Price_EUR_is_imputed"] == False]  # noqa: E712

    if request.require_purchasable and "Is_Purchasable" in candidates.columns:
        candidates = candidates[candidates["Is_Purchasable"] == 1]

    candidates = candidates[
        (candidates["Price_EUR"] >= request.budget_min_eur)
        & (candidates["Price_EUR"] <= request.budget_max_eur)
    ]
    if request.preferred_brands:
        candidates = candidates[candidates["Brand"].isin(request.preferred_brands)]
    if request.exclude_brands:
        candidates = candidates[~candidates["Brand"].isin(request.exclude_brands)]
    if request.min_ram_gb is not None and "RAM_GB" in candidates.columns:
        candidates = candidates[candidates["RAM_GB"] >= request.min_ram_gb]
    if request.require_5g and "Has_5G" in candidates.columns:
        candidates = candidates[candidates["Has_5G"] == 1]

    # de-duplicate storage/color variants of the same phone before ranking
    candidates = (
        candidates.sort_values("Price_EUR")
        .drop_duplicates(subset=["Brand", "Model_Name"], keep="first")
    )

    if candidates.empty:
        return None, "No phones match these filters — try relaxing budget or brand."

    weight_sum = sum(weights.values()) or 1.0
    match_score = pd.Series(0.0, index=candidates.index)
    for dim, w in weights.items():
        match_score = match_score + candidates[score_cols_map_[dim]] * w
    match_score = match_score / weight_sum

    candidates = candidates.assign(Match_Score=match_score.round(1))
    top = candidates.sort_values("Match_Score", ascending=False).head(request.top_n_results)

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
                # Step D — sub-scores for backend fusion ranker.
                # `Overall_Score` + `Value_Score` are the two single-number
                # signals the BE folds into compatibility / value;
                # `SubScores` exposes every per-dim score so the BE could
                # in future run a richer persona-aware sub-fusion.
                "Overall_Score": round(float(phone["Overall_Score"]), 2),
                "Value_Score": round(float(phone["Value_Score"]), 2),
                "SubScores": {
                    dim: round(float(phone[score_cols_map_[dim]]), 2)
                    for dim in SCORE_DIMENSIONS
                },
            }
        )
    return results, None
