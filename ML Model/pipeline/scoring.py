"""Composite scoring — direct port of notebook cell 96.

The notebook computes `lo` / `hi` quantiles *from the input df* (the dataset
loaded at training time). For prediction time we must use **frozen** quantiles
from the training set, otherwise the score of a single new phone row is
nonsense (e.g. `clip_norm` returns 0 for everything when lo=hi=NaN).

`ScoringSnapshot` stores the per-column `(lo, hi)` quantiles and the tier
maps. `compute_scores(df, snapshot)` then applies the same formula to
arbitrary dataframes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Dict, Tuple, Any

import numpy as np
import pandas as pd


TIER_MAP_5: Dict[str, float] = {
    "Unknown": 0.3, "Low": 0.2, "Medium": 0.5, "High": 0.75, "Ultra": 1.0,
}
STORAGE_TIER_MAP: Dict[str, float] = {
    "Unknown": 0.2, "Entry": 0.2, "Budget": 0.4, "Mid": 0.6, "Premium": 0.8, "Flagship": 1.0,
}


@dataclass
class ScoringSnapshot:
    """Frozen quantiles + tier maps used by `compute_scores`."""

    quantiles: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    tier_map_5: Dict[str, float] = field(default_factory=dict)
    storage_tier_map: Dict[str, float] = field(default_factory=dict)

    # ----- persistence -----
    def to_json(self) -> str:
        return json.dumps(
            {
                "quantiles": {k: list(v) for k, v in self.quantiles.items()},
                "tier_map_5": self.tier_map_5,
                "storage_tier_map": self.storage_tier_map,
            }
        )

    @classmethod
    def from_json(cls, blob: str) -> "ScoringSnapshot":
        d = json.loads(blob)
        return cls(
            quantiles={k: tuple(v) for k, v in d["quantiles"].items()},
            tier_map_5=d["tier_map_5"],
            storage_tier_map=d["storage_tier_map"],
        )

    @classmethod
    def from_dataframe(cls, df: pd.DataFrame, lo_q: float = 0.01, hi_q: float = 0.99) -> "ScoringSnapshot":
        """Build a snapshot by computing the (lo, hi) quantiles on the given df."""
        cols = [
            "AnTuTu_Score", "GeekBench_Score", "RAM_GB",
            "Main_Camera_MP", "Lens_Count", "Main_Aperture", "Selfie_Camera_MP",
            "Battery_mAh", "Wired_Charging_W",
            "PPI_Density", "Software_Support_Score", "Android_Major_Version",
            "Bluetooth_Version",
            "Weight_g", "Thickness_mm",
            "Storage_GB",
        ]
        quantiles: Dict[str, Tuple[float, float]] = {}
        for c in cols:
            if c in df.columns:
                s = df[c].astype(float)
                quantiles[c] = (float(s.quantile(lo_q)), float(s.quantile(hi_q)))
        return cls(
            quantiles=quantiles,
            tier_map_5=dict(TIER_MAP_5),
            storage_tier_map=dict(STORAGE_TIER_MAP),
        )


# ---------------------------------------------------------------------------
# helpers (work on a passed-in df, using the snapshot's quantiles)
# ---------------------------------------------------------------------------
def _clip_norm(s: pd.Series, lo: float, hi: float) -> pd.Series:
    s = s.astype(float).clip(lo, hi)
    return (s - lo) / (hi - lo + 1e-9)


def _log_norm(s: pd.Series, lo: float, hi: float) -> pd.Series:
    s = np.log1p(s.astype(float)).clip(lo, hi)
    return (s - lo) / (hi - lo + 1e-9)


def _yn(s: pd.Series) -> pd.Series:
    return s.map({"Yes": 1, "No": 0}).fillna(0).astype(float)


def _q(snap: ScoringSnapshot, col: str) -> Tuple[float, float]:
    """Return (lo, hi) for a column from the snapshot. Falls back to (0, 1)."""
    return snap.quantiles.get(col, (0.0, 1.0))


def _safe_clip(lo: float, hi: float) -> Tuple[float, float]:
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        return 0.0, 1.0
    return float(lo), float(hi)


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------
def compute_scores(df: pd.DataFrame, snap: ScoringSnapshot) -> pd.DataFrame:
    """Return df with 11 new columns: 9 dimension scores + Overall + Value."""
    df = df.copy()

    # clean Refresh_Rate once, share across Gaming + Display
    if "Refresh_Rate_Hz" in df.columns:
        df["_Refresh_Rate_Hz_clean"] = df["Refresh_Rate_Hz"].clip(upper=165)
    else:
        df["_Refresh_Rate_Hz_clean"] = 60.0

    lo, hi = _safe_clip(*_q(snap, "AnTuTu_Score"))
    df["Gaming_Score"] = (
        _log_norm(df.get("AnTuTu_Score", pd.Series(0, index=df.index)), lo, hi) * 0.35
        + _log_norm(df.get("GeekBench_Score", pd.Series(0, index=df.index)),
                    *_safe_clip(*_q(snap, "GeekBench_Score"))) * 0.15
        + _clip_norm(df.get("RAM_GB", pd.Series(0, index=df.index)),
                     *_safe_clip(*_q(snap, "RAM_GB"))) * 0.15
        + df.get("GPU_Is_Flagship", pd.Series(0, index=df.index)).astype(float) * 0.15
        + df.get("Chipset_Is_Flagship", pd.Series(0, index=df.index)).astype(float) * 0.10
        + ((df["_Refresh_Rate_Hz_clean"].clip(60, 165) - 60) / (165 - 60)) * 0.10
    ) * 100

    lo, hi = _safe_clip(*_q(snap, "Main_Camera_MP"))
    df["Camera_Score"] = (
        _clip_norm(df.get("Main_Camera_MP", pd.Series(0, index=df.index)), lo, hi) * 0.30
        + ((df.get("Lens_Count", pd.Series(1, index=df.index)).clip(1, 5) - 1) / 4) * 0.15
        + (1 - _clip_norm(df.get("Main_Aperture", pd.Series(0, index=df.index)),
                          *_safe_clip(*_q(snap, "Main_Aperture")))) * 0.20
        + _yn(df.get("OIS", pd.Series("No", index=df.index))) * 0.15
        + _yn(df.get("Camera_4K_Video", pd.Series("No", index=df.index))) * 0.10
        + _clip_norm(df.get("Selfie_Camera_MP", pd.Series(0, index=df.index)),
                     *_safe_clip(*_q(snap, "Selfie_Camera_MP"))) * 0.10
    ) * 100

    df["Battery_Score"] = (
        _clip_norm(df.get("Battery_mAh", pd.Series(0, index=df.index)),
                   *_safe_clip(*_q(snap, "Battery_mAh"))) * 0.55
        + _clip_norm(df.get("Wired_Charging_W", pd.Series(0, index=df.index)),
                     *_safe_clip(*_q(snap, "Wired_Charging_W"))) * 0.35
        + _yn(df.get("Reverse_Wireless_Charging", pd.Series("No", index=df.index))) * 0.10
    ) * 100

    df["_Display_Brightness_Norm"] = (
        df.get("Display_Brightness_Tier", pd.Series("Unknown", index=df.index))
        .map(snap.tier_map_5).fillna(0.3).astype(float)
    )
    df["Display_Score"] = (
        _clip_norm(df.get("PPI_Density", pd.Series(0, index=df.index)),
                   *_safe_clip(*_q(snap, "PPI_Density"))) * 0.30
        + ((df["_Refresh_Rate_Hz_clean"].clip(60, 165) - 60) / (165 - 60)) * 0.25
        + df["_Display_Brightness_Norm"] * 0.20
        + df.get("Display_Has_HDR", pd.Series(0, index=df.index)).astype(float) * 0.15
        + df.get("Display_Is_LTPO", pd.Series(0, index=df.index)).astype(float) * 0.10
    ) * 100

    df["Software_Score"] = (
        _clip_norm(df.get("Software_Support_Score", pd.Series(0, index=df.index)),
                   *_safe_clip(*_q(snap, "Software_Support_Score"))) * 0.55
        + _clip_norm(df.get("Android_Major_Version", pd.Series(0, index=df.index)),
                     *_safe_clip(*_q(snap, "Android_Major_Version"))) * 0.25
        + df.get("Long_Term_Support", pd.Series(0, index=df.index)).astype(float) * 0.20
    ) * 100

    df["Security_Score"] = (
        df.get("Has_Fingerprint", pd.Series(0, index=df.index)).astype(float) * 0.45
        + df.get("Has_Face_Unlock", pd.Series(0, index=df.index)).astype(float) * 0.25
        + df.get("Fingerprint_Position", pd.Series("", index=df.index))
            .astype(str).str.contains("display", case=False, na=False).astype(int) * 0.30
    ) * 100

    df["Connectivity_Score"] = (
        (df.get("Max_Network_Gen", pd.Series(0, index=df.index)).clip(0, 5) / 5) * 0.35
        + (df.get("WiFi_Generation", pd.Series(0, index=df.index)).clip(0, 6) / 6) * 0.25
        + df.get("Has_Multi_GNSS", pd.Series(0, index=df.index)).astype(float) * 0.15
        + df.get("NFC", pd.Series("No", index=df.index)).map({"Yes": 1, "No": 0}).fillna(0).astype(float) * 0.15
        + _clip_norm(df.get("Bluetooth_Version", pd.Series(0, index=df.index)),
                     *_safe_clip(*_q(snap, "Bluetooth_Version"))) * 0.10
    ) * 100

    df["Portability_Score"] = (
        (1 - _clip_norm(df.get("Weight_g", pd.Series(0, index=df.index)),
                        *_safe_clip(*_q(snap, "Weight_g")))) * 0.5
        + (1 - _clip_norm(df.get("Thickness_mm", pd.Series(0, index=df.index)),
                          *_safe_clip(*_q(snap, "Thickness_mm")))) * 0.5
    ) * 100

    df["Storage_Score"] = (
        _clip_norm(df.get("Storage_GB", pd.Series(0, index=df.index)),
                   *_safe_clip(*_q(snap, "Storage_GB"))) * 0.5
        + df.get("Storage_Tier", pd.Series("Unknown", index=df.index))
            .map(snap.storage_tier_map).fillna(0.2).astype(float) * 0.5
    ) * 100

    df["Overall_Score"] = (
        df["Gaming_Score"] * 0.22 + df["Camera_Score"] * 0.18
        + df["Battery_Score"] * 0.16 + df["Display_Score"] * 0.14
        + df["Software_Score"] * 0.12 + df["Storage_Score"] * 0.08
        + df["Connectivity_Score"] * 0.05 + df["Security_Score"] * 0.03
        + df["Portability_Score"] * 0.02
    )

    df["Value_Ratio"] = df["Overall_Score"] / np.log1p(df.get("Price_EUR", pd.Series(1, index=df.index)))
    df["Value_Score"] = df["Value_Ratio"].rank(pct=True) * 100

    df = df.drop(columns=["_Refresh_Rate_Hz_clean", "_Display_Brightness_Norm"], errors="ignore")
    return df


def score_one(df: pd.DataFrame, snap: ScoringSnapshot) -> Dict[str, float]:
    """Convenience: compute_scores on a single row, return the score dict."""
    out = compute_scores(df, snap)
    if out.empty:
        return {}
    cols = [
        "Gaming_Score", "Camera_Score", "Battery_Score", "Display_Score",
        "Software_Score", "Storage_Score", "Connectivity_Score",
        "Security_Score", "Portability_Score", "Overall_Score", "Value_Score",
    ]
    row = out.iloc[0]
    return {c: round(float(row[c]), 2) for c in cols if c in out.columns}
