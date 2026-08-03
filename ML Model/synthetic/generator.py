"""Generate a synthetic customer dataset for segmentation.

Quickstart
----------
From the project root:

    python "ML Model/synthetic/generator.py" --n 8000 --seed 42

This writes:
    ML Model/synthetic_outputs/synthetic_customers.csv             (one row per user)
    ML Model/synthetic_outputs/synthetic_customers_schema.json     (column metadata)
    ML Model/synthetic_outputs/archetype_summary.csv                (per-archetype stats)

Algorithm
---------
1. Pick an archetype for each row using ARCHETYPE_WEIGHTS (weighted random).
2. Sample demographics (age / gender / city / city_tier) from the spec.
3. Sample budget range + preferred brand from the spec.
4. Sample the seven interest scores: centroid + Gaussian noise, clipped to 0–100.
5. Sample hardware preferences (RAM / storage / refresh / battery) — snapped
   to allowed choices AND kept consistent with the interest scores:
       gaming_interest >= 80  →  min_refresh_rate_hz >= 120
       battery_interest >= 80 →  min_battery_mah    >= 5000
       camera_interest  >= 85 →  min_storage_gb     >= 128
       chipset_tier = Flagship → min_ram_gb        >= 8
6. Sample behavioural + engagement columns with light noise around defaults.
7. Emit a DataFrame + write CSV / JSON schema / summary stats.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd

# Make this script runnable from any CWD (mirrors scripts/_trim_similarity_bundle.py).
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent  # …/ML Model/
sys.path.insert(0, str(PROJECT_ROOT))

from synthetic.archetypes import (  # noqa: E402
    ARCHETYPES, ARCHETYPE_NAMES, ARCHETYPE_WEIGHTS, ArchetypeSpec,
)
from synthetic.feature_schema import (  # noqa: E402
    BRANDS, CATEGORICAL_FEATURES, CITIES, CITY_TIERS,
    COLUMN_BY_NAME, COLUMNS, FIRST_NAMES, GENDERS,
    INTEREST_SCORES, INTERACTION_CHANNELS,
    LAST_NAMES, NUMERIC_FEATURES,
    to_json_schema,
)
from synthetic.noise import (  # noqa: E402
    BATTERY_MAH_CHOICES, RAM_GB_CHOICES, REFRESH_RATE_CHOICES,
    STORAGE_GB_CHOICES, gaussian_around, snap_to_choice,
    weighted_choice,
)


# ---------------------------------------------------------------------------
# Per-row sampler — generates ONE row dict
# ---------------------------------------------------------------------------
def _sample_one(spec: ArchetypeSpec, idx: int, rng: np.random.Generator) -> Dict:
    """Sample one synthetic customer from the given archetype spec."""
    # ---- Identity (no archetype influence)
    customer_id = f"syn_u_{idx:05d}"
    customer_name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"

    # ---- Demographics
    age_lo, age_hi = spec.age_range
    age = int(round(gaussian_around(
        (age_lo + age_hi) / 2,
        sigma_frac=0.10,
        lo=age_lo, hi=age_hi,
        rng=rng,
    )))
    gender = weighted_choice(
        [v for v, _ in spec.gender_weights],
        [w for _, w in spec.gender_weights],
        rng=rng,
    )
    city = rng.choice(CITIES)
    city_tier = weighted_choice(
        [v for v, _ in spec.city_tier_weights],
        [w for _, w in spec.city_tier_weights],
        rng=rng,
    )
    country = "Nepal"

    # ---- Budget
    budget_min_npr = int(round(gaussian_around(
        spec.budget_min_npr, sigma_frac=0.10,
        lo=spec.budget_min_npr * 0.6, hi=spec.budget_min_npr * 1.4,
        rng=rng,
    )))
    budget_max_npr = int(round(gaussian_around(
        spec.budget_max_npr, sigma_frac=0.10,
        lo=spec.budget_min_npr * 1.2, hi=spec.budget_max_npr * 1.3,
        rng=rng,
    )))
    # Ensure budget_min < budget_max.
    if budget_min_npr >= budget_max_npr:
        budget_max_npr = budget_min_npr + 20_000

    # ---- Brand
    preferred_brand = weighted_choice(
        [v for v, _ in spec.brands],
        [w for _, w in spec.brands],
        rng=rng,
    )
    brand_loyalty_score = gaussian_around(
        spec.brand_loyalty_score,
        sigma_frac=0.10,
        lo=0.4, hi=1.0,
        rng=rng,
    )

    # ---- Interest scores — centroid + Gaussian noise (these are the
    #      primary clustering axes; they carry the cluster identity).
    interest_values: Dict[str, float] = {}
    for k in INTEREST_SCORES:
        centroid = spec.interests[k]
        interest_values[k] = gaussian_around(
            centroid, sigma_frac=0.10, lo=0, hi=100, rng=rng,
        )

    # ---- Hardware — internally consistent with the interest scores.
    # The anchors:
    #   gaming_interest >= 80   →  refresh_rate  >= 120
    #   display_interest >= 80  →  refresh_rate  >= 120
    #   battery_interest >= 80  →  battery_mah   >= 5000
    #   camera_interest  >= 85  →  storage       >= 128
    #   chipset_tier = Flagship → ram           >= 8
    min_refresh = spec.min_refresh_rate_hz
    if interest_values["gaming_interest"] >= 80 or interest_values["display_interest"] >= 80:
        min_refresh = max(min_refresh, 120)
    min_refresh = int(snap_to_choice(min_refresh, REFRESH_RATE_CHOICES, rng=rng))

    min_battery = int(snap_to_choice(
        gaussian_around(spec.min_battery_mah, sigma_frac=0.10,
                         lo=3000, hi=7000, rng=rng),
        BATTERY_MAH_CHOICES, rng=rng,
    ))
    if interest_values["battery_interest"] >= 80:
        min_battery = max(min_battery, 5000)

    min_storage = int(snap_to_choice(
        gaussian_around(spec.min_storage_gb, sigma_frac=0.10,
                         lo=32, hi=512, rng=rng),
        STORAGE_GB_CHOICES, rng=rng,
    ))
    if interest_values["camera_interest"] >= 85:
        min_storage = max(min_storage, 128)

    chipset_tier = spec.chipset_tier

    min_ram = int(snap_to_choice(
        gaussian_around(spec.min_ram_gb, sigma_frac=0.10,
                         lo=4, hi=16, rng=rng),
        RAM_GB_CHOICES, rng=rng,
    ))
    if chipset_tier in ("Flagship", "Flagship-Killer"):
        min_ram = max(min_ram, 8)

    # ---- Behavioural — default ± 15% Gaussian noise
    purchase_frequency_per_year = round(gaussian_around(
        spec.purchase_frequency_per_year, sigma_frac=0.20,
        lo=0.5, hi=6.0, rng=rng,
    ), 1)
    n_past_purchases = int(round(gaussian_around(
        spec.n_past_purchases, sigma_frac=0.30,
        lo=0, hi=10, rng=rng,
    )))
    avg_session_minutes = round(gaussian_around(
        spec.avg_session_minutes, sigma_frac=0.20,
        lo=1, hi=60, rng=rng,
    ), 1)
    search_freq_per_week = int(round(gaussian_around(
        spec.search_freq_per_week, sigma_frac=0.30,
        lo=0, hi=50, rng=rng,
    )))
    compare_freq_per_week = int(round(gaussian_around(
        spec.compare_freq_per_week, sigma_frac=0.30,
        lo=0, hi=25, rng=rng,
    )))
    click_through_rate = round(gaussian_around(
        spec.click_through_rate, sigma_frac=0.20,
        lo=0, hi=1, rng=rng,
    ), 2)

    # ---- Engagement
    recency_days = int(round(gaussian_around(
        spec.recency_days, sigma_frac=0.30,
        lo=0, hi=720, rng=rng,
    )))
    avg_rating_given = round(gaussian_around(
        spec.avg_rating_given, sigma_frac=0.15,
        lo=1, hi=5, rng=rng,
    ), 1)
    interaction_channel = weighted_choice(
        [v for v, _ in spec.interaction_channel_weights],
        [w for _, w in spec.interaction_channel_weights],
        rng=rng,
    )
    wishlist_conversion_rate = round(gaussian_around(
        spec.wishlist_conversion_rate, sigma_frac=0.20,
        lo=0, hi=1, rng=rng,
    ), 2)
    accessory_affinity = round(gaussian_around(
        spec.accessory_affinity, sigma_frac=0.20,
        lo=0, hi=1, rng=rng,
    ), 2)

    # Build the row, BUT we drop `true_archetype` here — we add it once per row
    # AFTER sampling so the consumer can read df['true_archetype'] directly.
    row: Dict = {
        "customer_id": customer_id,
        "customer_name": customer_name,
        "age": age,
        "gender": gender,
        "city": city,
        "country": country,
        "city_tier": city_tier,
        "budget_min_npr": budget_min_npr,
        "budget_max_npr": budget_max_npr,
        "preferred_brand": preferred_brand,
        "brand_loyalty_score": round(brand_loyalty_score, 2),
        # Interest scores
        **{k: round(v, 1) for k, v in interest_values.items()},
        # Hardware
        "min_ram_gb": min_ram,
        "min_storage_gb": min_storage,
        "chipset_tier": chipset_tier,
        "min_refresh_rate_hz": min_refresh,
        "min_battery_mah": min_battery,
        # Behavioural
        "purchase_frequency_per_year": purchase_frequency_per_year,
        "n_past_purchases": n_past_purchases,
        "avg_session_minutes": avg_session_minutes,
        "search_freq_per_week": search_freq_per_week,
        "compare_freq_per_week": compare_freq_per_week,
        "click_through_rate": click_through_rate,
        # Engagement
        "recency_days": recency_days,
        "avg_rating_given": avg_rating_given,
        "interaction_channel": interaction_channel,
        "wishlist_conversion_rate": wishlist_conversion_rate,
        "accessory_affinity": accessory_affinity,
    }
    return row


# ---------------------------------------------------------------------------
# Top-level public entry point
# ---------------------------------------------------------------------------
def generate(
    n_users: int = 8000,
    seed: int = 42,
) -> pd.DataFrame:
    """Generate a fresh synthetic customer DataFrame.

    Parameters
    ----------
    n_users : int
        Total number of rows to generate. Distribute across archetypes
        according to ARCHETYPE_WEIGHTS.
    seed : int
        Seed for the numpy random generator (for reproducibility).
    """
    rng = np.random.default_rng(seed)
    archetype_names = list(ARCHETYPE_WEIGHTS.keys())
    archetype_probs = list(ARCHETYPE_WEIGHTS.values())

    # Pre-sample the archetype for each row so we can compute summary stats
    # BEFORE inserting the row (and keep counts deterministic per-seed).
    sampled_archetypes = rng.choice(
        archetype_names, size=n_users, p=archetype_probs,
    )

    rows: List[Dict] = []
    for i, arch_name in enumerate(sampled_archetypes):
        spec = ARCHETYPES[arch_name]
        row = _sample_one(spec, i, rng)
        row["true_archetype"] = str(arch_name)
        rows.append(row)

    df = pd.DataFrame(rows, columns=[c.name for c in COLUMNS])
    return df


def write_outputs(
    df: pd.DataFrame,
    output_csv: Path,
    write_schema: bool = True,
    write_summary: bool = True,
) -> Dict[str, Path]:
    """Write the CSV plus optional JSON schema + archetype summary CSV.

    Returns a dict of {name: path} for everything that was written.
    """
    output_csv = Path(output_csv)
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_csv, index=False)

    written: Dict[str, Path] = {"synthetic_customers": output_csv}

    if write_schema:
        schema_path = output_csv.parent / "synthetic_customers_schema.json"
        with schema_path.open("w", encoding="utf-8") as f:
            json.dump(to_json_schema(), f, indent=2, ensure_ascii=False)
        written["schema"] = schema_path

    if write_summary:
        summary_path = output_csv.parent / "archetype_summary.csv"
        # Per-archetype mean of numeric columns + counts.
        numeric_cols = [c.name for c in COLUMNS
                        if c.dtype in ("int", "float")
                        and c.in_cluster]
        # Mode of each categorical column per archetype.
        categorical_cols = [c.name for c in COLUMNS
                            if c.dtype == "category" and c.in_cluster]
        mode_agg = {c: (lambda s: s.mode().iloc[0] if not s.mode().empty else "")
                    for c in categorical_cols}

        grouped = df.groupby("true_archetype")
        means = grouped[numeric_cols].mean().round(2)
        modes = grouped.agg(mode_agg)
        counts = grouped.size().rename("count")
        pct = (counts / counts.sum() * 100).round(2).rename("pct")

        summary = pd.concat([counts, pct, means, modes], axis=1)
        # Bring useful columns to the front.
        lead = ["count", "pct"]
        # Quick drop of any leading cols we accidentally doubled.
        lead = [c for c in lead if c in summary.columns]
        other = [c for c in summary.columns if c not in lead]
        summary = summary[lead + other]
        summary.to_csv(summary_path)
        written["archetype_summary"] = summary_path

    return written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Generate synthetic customer dataset for segmentation"
    )
    parser.add_argument("--n", type=int, default=8000,
                        help="Number of synthetic users to generate (default 8000)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility")
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "synthetic_outputs" / "synthetic_customers.csv",
        help="Output CSV path",
    )
    parser.add_argument("--no-schema", action="store_true",
                        help="Skip writing the JSON schema sidecar")
    parser.add_argument("--no-summary", action="store_true",
                        help="Skip writing the archetype-summary sidecar")
    args = parser.parse_args()

    print(f"Generating {args.n} synthetic customers (seed={args.seed})…")
    df = generate(n_users=args.n, seed=args.seed)
    print(f"  -> wrote DataFrame shape: {df.shape}")

    written = write_outputs(
        df,
        output_csv=args.output,
        write_schema=not args.no_schema,
        write_summary=not args.no_summary,
    )
    print("\nFiles written:")
    for name, path in written.items():
        print(f"  - {name:<22} → {path}")

    # Quick console sanity report
    print("\nArchetype distribution (true_archetype):")
    counts = df["true_archetype"].value_counts()
    for arch, n in counts.items():
        share = n / len(df) * 100
        target = ARCHETYPE_WEIGHTS.get(arch, 0) * 100
        print(f"  {arch:<25} {n:>5d}  ({share:5.2f}%)  target={target:5.2f}%")


if __name__ == "__main__":
    main()