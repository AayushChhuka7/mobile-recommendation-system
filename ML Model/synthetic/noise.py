"""Gaussian noise helpers + weighted categorical samplers.

These are the building blocks of the per-row sampling inside generator.py.
The idea: each archetype centroid gets ±10% Gaussian noise per row so the
clusters are fuzzy enough that an algorithm has work to do, but tight enough
that K-Means at the correct k can recover the structure.

The functions here are deliberately simple (no sklearn / numpy tricks) so
they're easy to read and easy to test.
"""

from __future__ import annotations

from typing import Iterable, Sequence, Tuple, TypeVar

import numpy as np

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Per-row noise
# ---------------------------------------------------------------------------
def gaussian_around(
    value: float,
    sigma_frac: float = 0.10,
    lo: float | None = None,
    hi: float | None = None,
    rng: np.random.Generator | None = None,
) -> float:
    """Return value + Gaussian(0, sigma_frac * value), clipped to [lo, hi].

    Why we use relative sigma (not absolute): a Gamer whose gaming_interest is 92
    gets noise of stddev 9.2, while a Budget Buyer whose value is 35 gets stddev
    3.5. Clusters stay tight in proportion to their centroid, regardless of axis.

    For zero-centroid values (e.g. a Budget Buyer's gaming_interest might be 35,
    never 0) we still use proportional noise — a fraction of 35 is small enough.

    Parameters
    ----------
    value : float
        Centroid value to noise up.
    sigma_frac : float
        Standard deviation as a fraction of `value` (default 10%).
    lo, hi : float | None
        Optional clip bounds. If both None, no clipping.
    rng : np.random.Generator | None
        Optional numpy random generator for reproducibility.
    """
    if rng is None:
        rng = np.random.default_rng()
    sigma = abs(value) * sigma_frac
    out = float(value + rng.normal(0.0, sigma))
    if lo is not None:
        out = max(out, lo)
    if hi is not None:
        out = min(out, hi)
    return out


def clip_to_range(
    value: float,
    lo: float,
    hi: float,
) -> float:
    """Clamp a value into the closed interval [lo, hi]. Coerces to int if both bounds are int."""
    out = max(lo, min(hi, value))
    if isinstance(lo, int) and isinstance(hi, int):
        return int(round(out))
    return float(out)


# ---------------------------------------------------------------------------
# Categorical sampling
# ---------------------------------------------------------------------------
def weighted_choice(
    choices: Sequence[T],
    weights: Sequence[float],
    rng: np.random.Generator | None = None,
) -> T:
    """Sample one item from `choices` with the given relative `weights`.

    Mirrors `numpy.random.Generator.choice` but with explicit weights and a
    pythonic fallback so we don't need to prebuild arrays of objects.
    """
    if rng is None:
        rng = np.random.default_rng()
    if len(choices) != len(weights):
        raise ValueError(
            f"choices ({len(choices)}) and weights ({len(weights)}) length mismatch"
        )
    total = sum(weights)
    if total <= 0:
        raise ValueError(f"weights must sum to > 0; got {total}")
    normalised = np.asarray(weights, dtype=float) / total
    return choices[int(rng.choice(len(choices), p=normalised))]


def sample_categorical_list(
    values_and_weights: Iterable[Tuple[T, float]],
    rng: np.random.Generator | None = None,
) -> T:
    """Convenience: `[(a, 0.7), (b, 0.3)]` → returns `a` or `b`."""
    values, weights = zip(*values_and_weights)
    return weighted_choice(values, weights, rng=rng)


# ---------------------------------------------------------------------------
# Integer-snap helpers
# ---------------------------------------------------------------------------
def snap_to_choice(
    value: float,
    choices: Sequence[T],
    rng: np.random.Generator | None = None,
) -> T:
    """Snap a noisy float to the closest of `choices`.

    Used for things like `min_ram_gb` — we noise up the float 10, then snap
    to the allowed choices (4 / 6 / 8 / 12 / 16) so the categorical feature
    never ends up at, say, 9.4.
    """
    if rng is None:
        rng = np.random.default_rng()
    choices_list = list(choices)
    distances = [abs(value - c) for c in choices_list]
    # Tie-break randomly so we don't always pick the lower one.
    min_d = min(distances)
    candidates = [c for c, d in zip(choices_list, distances) if d == min_d]
    return candidates[int(rng.integers(0, len(candidates)))]


# ---------------------------------------------------------------------------
# Allowed value pools (mirrors the schema)
# ---------------------------------------------------------------------------
RAM_GB_CHOICES: Tuple[int, ...] = (4, 6, 8, 12, 16)
STORAGE_GB_CHOICES: Tuple[int, ...] = (32, 64, 128, 256, 512)
REFRESH_RATE_CHOICES: Tuple[int, ...] = (60, 90, 120, 144)
BATTERY_MAH_CHOICES: Tuple[int, ...] = (3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000)
