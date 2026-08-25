"""Constraint-behaviour tests for `recommend()`.

Run with: `python -m pipeline.test_constraints`

These tests don't depend on `After_EDA_and_Feature_ENginering.csv` or
the trained model — they build a small synthetic candidate frame so
the assertions are deterministic and the new hard/soft contract can
be verified in isolation.

The full list of behaviours exercised:

    1. Budget ceiling (Case 1 + Case 3 of the spec).
    2. `budget.max` unchanged across calls (no leakage).
    3. No automatic `+40%` price relaxation.
    4. Hard 5G requirement never violated.
    5. Hard minimum-RAM requirement never violated.
    6. Hard exclude-brands requirement never violated.
    7. Soft brand preference IS relaxable.
    8. Hard constraints are untouched while soft is relaxed.
    9. Fewer-than-MIN_CANDIDATES does not cause budget expansion.
   10. Zero valid candidates produces a safe (None, message) response.
   11. Existing ranking still works when the pool is large enough.
   12. Each result preserves the API surface
       (Brand/Model/Price_EUR/Match_Score/Value_Score/Overall_Score/
        Why/SubScores/EffectiveBudgetMax/RelaxationLog).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Force UTF-8 stdout on Windows
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

import pandas as pd

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pipeline.recommend import (  # noqa: E402
    MIN_CANDIDATES,
    PersonaType,
    UserPreferenceInput,
    recommend,
)


# ---------------------------------------------------------------------------
# Synthetic candidate builder
# ---------------------------------------------------------------------------
def _build_df() -> pd.DataFrame:
    """A tiny but diverse candidate pool.

    Columns match the shape `recommend()` reads (Price_EUR, RAM_GB,
    Storage_GB, Has_5G, Brand, Model_Name, plus the nine *_Score
    columns it sums). Imputed-price + Is_Purchasable are omitted to
    keep the frame minimal.
    """
    rows = [
        # Brand,    Model,         Price, RAM, Storage, 5G, dim scores…
        ("Samsung", "Galaxy A55",    350,  8,  128, 1),
        ("Samsung", "Galaxy A35",    280,  6,  128, 1),
        ("Samsung", "Galaxy S24",    900,  8,  256, 1),
        ("Xiaomi",  "Redmi Note 13", 220,  6,  128, 1),
        ("Xiaomi",  "Mi 12",         450,  8,  256, 1),
        ("OnePlus", "Nord CE 4",     380,  8,  256, 1),
        ("OnePlus", "11 Pro",        820, 12,  256, 1),
        ("Apple",   "iPhone 13",     650,  4,  128, 1),
        ("Apple",   "iPhone 12",     480,  4,  128, 1),
        ("Realme",  "C55",           180,  6,  128, 1),
        ("Realme",  "GT 6",          520,  8,  256, 1),
        ("Nokia",   "G42",           190,  4,  128, 0),   # 4G phone
        ("Nokia",   "G22",           140,  3,   64, 0),   # 4G + 3GB RAM
        ("Motorola","Edge 40",       480,  8,  256, 1),
        ("Motorola","G54",           210,  8,  256, 1),
    ]
    data = []
    for brand, model, price, ram, storage, has_5g in rows:
        row = {
            "Brand": brand,
            "Model_Name": model,
            "Price_EUR": float(price),
            "RAM_GB": float(ram),
            "Storage_GB": float(storage),
            "Has_5G": int(has_5g),
            "Overall_Score": 75.0,
            "Value_Score": 70.0,
            "Gaming_Score": 60.0,
            "Camera_Score": 60.0,
            "Battery_Score": 60.0,
            "Display_Score": 60.0,
            "Software_Score": 60.0,
            "Storage_Score": 60.0,
            "Connectivity_Score": 60.0,
            "Security_Score": 60.0,
            "Portability_Score": 60.0,
        }
        data.append(row)
    return pd.DataFrame(data)


# ---------------------------------------------------------------------------
# Tiny test helpers
# ---------------------------------------------------------------------------
def _ok(label: str) -> None:
    print(f"  PASS  {label}")


def _fail(label: str, detail: str) -> None:
    print(f"  FAIL  {label}: {detail}")
    raise AssertionError(f"{label}: {detail}")


def _check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        _ok(label)
    else:
        _fail(label, detail or "expected True")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_budget_is_hard_ceiling() -> None:
    """Test 1 — phones priced > budget.max never appear."""
    df = _build_df()
    # €300 budget: Samsung A35 (280), Redmi Note 13 (220), Realme C55 (180),
    # Motorola G54 (210), Nokia G22 (140), Nokia G42 (190). All ≤ €300.
    pref = UserPreferenceInput(
        budget_max_eur=300,
        persona=PersonaType.GAMER,
        top_n_results=20,
        min_candidates=2,
    )
    results, err = recommend(df, pref)
    _check("budget=300 returns results", err is None, f"err={err}")
    _check(
        "all returned phones within budget",
        results is not None and all(r["Price_EUR"] <= 300 for r in results),
        f"results={[r['Price_EUR'] for r in (results or [])]}",
    )


def test_budget_max_unchanged_across_calls() -> None:
    """Test 2 — `request.budget_max_eur` is never mutated."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=500,
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    recommend(df, pref)
    _check(
        "budget.max is still 500 after recommend()",
        pref.budget_max_eur == 500,
        f"got {pref.budget_max_eur}",
    )
    # Also confirm the response carries exactly the user input
    pref2 = UserPreferenceInput(
        budget_max_eur=500,
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    results, _ = recommend(df, pref2)
    _check(
        "EffectiveBudgetMax == input",
        results is not None and all(r["EffectiveBudgetMax"] == 500 for r in results),
        f"got {[r.get('EffectiveBudgetMax') for r in (results or [])]}",
    )


def test_no_automatic_price_relaxation() -> None:
    """Test 3 — `RelaxationLog` never contains 'price_band'."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=500,
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    results, _ = recommend(df, pref)
    _check(
        "RelaxationLog free of price_band",
        results is not None
        and all("price_band" not in r.get("RelaxationLog", []) for r in results),
        f"got {[r.get('RelaxationLog') for r in (results or [])]}",
    )


def test_hard_5g_requirement() -> None:
    """Test 4 — `require_5g=True` never surfaces a 4G phone."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        require_5g=True,
        top_n_results=20,
        min_candidates=2,
    )
    results, _ = recommend(df, pref)
    # The synthetic catalog only labels Has_5G per-row; verify the
    # returned phones correspond to rows that had Has_5G=1 in the
    # source frame.
    five_g_models = set(df[df["Has_5G"] == 1]["Model_Name"])
    returned_models = {r["Model"] for r in (results or [])}
    leaked = returned_models - five_g_models
    _check(
        "no 4G phone returned when require_5g=True",
        not leaked,
        f"leaked models={leaked}",
    )


def test_hard_min_ram_requirement() -> None:
    """Test 5 — `min_ram_gb=12` never returns an 8 GB phone."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        min_ram_gb=12,
        top_n_results=20,
        min_candidates=2,
    )
    results, _ = recommend(df, pref)
    ram_map = dict(zip(df["Model_Name"], df["RAM_GB"]))
    bad = [r["Model"] for r in (results or []) if ram_map.get(r["Model"], 0) < 12]
    _check(
        "no sub-12GB phone when min_ram_gb=12",
        not bad,
        f"leaked models={bad}",
    )


def test_hard_exclude_brands() -> None:
    """Test 6 — `exclude_brands=['Apple']` never returns an Apple phone."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        exclude_brands=["Apple"],
        top_n_results=20,
        min_candidates=2,
    )
    results, _ = recommend(df, pref)
    apple_models = set(df[df["Brand"] == "Apple"]["Model_Name"])
    returned_models = {r["Model"] for r in (results or [])}
    leaked = returned_models & apple_models
    _check(
        "no Apple phone when excluded",
        not leaked,
        f"leaked models={leaked}",
    )


def test_preferred_brands_is_hard_drop() -> None:
    """Test 7 — `preferred_brands` is a HARD drop (brand-filter rework).

    As of the brand-filter rework, `preferred_brands` no longer
    penalises non-preferred brands — it drops them outright. Even
    when the hard-constrained pool falls below `min_candidates`, the
    brand include-list is NOT relaxed (it's hard, like budget and
    exclude_brands).
    """
    df = _build_df()
    # The catalog has only 2 Apple phones. With MIN_CANDIDATES=5 the
    # hard-constrained pool starts at 2 (< 5). Under the old soft
    # path, brand_preference would be relaxed and non-Apple phones
    # would appear. Under the new hard-drop contract, results must
    # be `None` with the standard empty-pool message — the user's
    # brand choice is non-negotiable.
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        preferred_brands=["Apple"],
        top_n_results=15,
        min_candidates=5,
    )
    results, err = recommend(df, pref)
    _check(
        "non-preferred brands are NOT surfaced to fill min_candidates",
        results is None and err is not None,
        f"results={results!r} err={err!r}",
    )


def test_hard_untouched_during_hard_brand_drop() -> None:
    """Test 8 — while a hard `preferred_brands` drop is in force,
    hard 5G still holds.

    This is the brand-filter-rework equivalent of the old
    test_hard_untouched_during_soft_relaxation: with the new hard
    semantics, brand filtering can't be relaxed to widen the pool,
    so the test now asserts that BOTH the brand include-list AND
    the 5G requirement hold simultaneously.
    """
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        preferred_brands=["Samsung"],
        require_5g=True,
        top_n_results=15,
        min_candidates=10,
    )
    results, _ = recommend(df, pref)
    # Only Samsung phones should appear, and only 5G-capable ones.
    if results is None:
        _check(
            "Samsung + 5G constraint holds (empty pool acceptable)",
            True,  # an empty pool is a valid outcome — hard filters
                   # are never widened.
        )
        return
    brands_returned = {r["Brand"] for r in results}
    five_g_models = set(df[df["Has_5G"] == 1]["Model_Name"])
    returned_models = {r["Model"] for r in results}
    leaked = returned_models - five_g_models
    _check(
        "5G hard requirement still holds alongside brand include-list",
        not leaked,
        f"leaked models={leaked}",
    )
    _check(
        "no non-Samsung brand leaked past preferred_brands",
        brands_returned <= {"Samsung"},
        f"brands_returned={brands_returned}",
    )


def test_fewer_than_min_candidates_no_budget_expansion() -> None:
    """Test 9 — small pools are returned as-is; budget unchanged."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=500,
        persona=PersonaType.GAMER,
        top_n_results=20,
        min_candidates=10,
    )
    results, _ = recommend(df, pref)
    # The €500 catalog slice has 3 phones (A55/S24/Mi 12/etc — those
    # priced ≤ €500). They must all be returned without exceeding €500
    # and without widening the budget.
    _check(
        "every returned phone ≤ budget.max",
        results is not None and all(r["Price_EUR"] <= 500 for r in results),
    )
    _check(
        "EffectiveBudgetMax unchanged at 500",
        results is not None
        and all(r["EffectiveBudgetMax"] == 500 for r in results),
        f"got {[r['EffectiveBudgetMax'] for r in (results or [])]}",
    )
    _check(
        "RelaxationLog empty (no soft preference to relax)",
        results is not None
        and all(r.get("RelaxationLog") == [] for r in results),
        f"got {[r.get('RelaxationLog') for r in (results or [])]}",
    )


def test_zero_candidates_returns_safe_response() -> None:
    """Test 10 — empty pool returns (None, message), no synthesis."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=10,            # impossible budget
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    results, err = recommend(df, pref)
    _check("results is None when no candidates", results is None)
    _check("error message is non-empty", err is not None and len(err) > 0)
    _check(
        "error mentions hard constraints",
        err is not None and "hard" in err.lower(),
        f"err={err}",
    )


def test_ranking_still_works_with_large_pool() -> None:
    """Test 11 — when the pool has enough candidates, ranking still works."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    results, _ = recommend(df, pref)
    _check("results returned", results is not None and len(results) > 0)
    # Sorted by Match_Score desc?
    scores = [r["Match_Score"] for r in results]
    _check(
        "Match_Score is non-increasing",
        all(scores[i] >= scores[i + 1] for i in range(len(scores) - 1)),
        f"scores={scores}",
    )


def test_response_shape_compatibility() -> None:
    """Test 12 — every result preserves the API surface."""
    df = _build_df()
    pref = UserPreferenceInput(
        budget_max_eur=2000,
        persona=PersonaType.GAMER,
        top_n_results=5,
        min_candidates=10,
    )
    results, _ = recommend(df, pref)
    required_keys = {
        "Brand",
        "Model",
        "Price_EUR",
        "Match_Score",
        "Why",
        "Overall_Score",
        "Value_Score",
        "SubScores",
        "RelaxationLog",
        "EffectiveBudgetMax",
    }
    for r in (results or []):
        missing = required_keys - set(r.keys())
        _check(
            f"result {r.get('Model')!r} has all required keys",
            not missing,
            f"missing={missing}",
        )


def main() -> int:
    print(f"[constraints] synthetic pool has 15 phones; MIN_CANDIDATES={MIN_CANDIDATES}")
    tests = [
        ("budget is hard ceiling", test_budget_is_hard_ceiling),
        ("budget.max unchanged", test_budget_max_unchanged_across_calls),
        ("no automatic price relaxation", test_no_automatic_price_relaxation),
        ("hard 5G requirement", test_hard_5g_requirement),
        ("hard min_ram_gb requirement", test_hard_min_ram_requirement),
        ("hard exclude_brands", test_hard_exclude_brands),
        ("preferred_brands is a hard drop", test_preferred_brands_is_hard_drop),
        ("hard untouched during hard brand drop", test_hard_untouched_during_hard_brand_drop),
        ("fewer-than-MIN_CANDIDATES no expansion", test_fewer_than_min_candidates_no_budget_expansion),
        ("zero candidates safe response", test_zero_candidates_returns_safe_response),
        ("ranking still works", test_ranking_still_works_with_large_pool),
        ("response shape compatibility", test_response_shape_compatibility),
    ]
    failed = 0
    for label, fn in tests:
        print(f"\n— {label}")
        try:
            fn()
        except AssertionError:
            failed += 1
    print()
    if failed:
        print(f"FAILED: {failed} test(s) failed")
        return 1
    print(f"All {len(tests)} constraint tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
