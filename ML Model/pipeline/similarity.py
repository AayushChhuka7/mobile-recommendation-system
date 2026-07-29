"""
pipeline.similarity — content-based similarity (Step D).

Owned by both the training script (`scripts/build_similarity_bundle.py`)
and the FastAPI service (`pipeline/serve.py::_load_similarity_bundle`).
Functions here are pure and stateless so they pickle / unpickle cleanly
from any Python process, regardless of which `__main__` is launching it.

Why this module exists at all:
    A previous version defined `apply_weights` as a closure inside a
    Jupyter notebook cell.  `pickle` recorded it as `__main__.apply_weights`,
    which is not importable from uvicorn's `__main__` and broke the
    `/similarity/score` endpoint with:

        AttributeError: Can't get attribute 'apply_weights' on
        <module '__main__' from '...venv\\Scripts\\uvicorn.exe\\__main__.py'>

The fix has two layers, applied together:

    1. Pure, importable callables here (this file) so any future fitted
       sklearn `Pipeline` that references `apply_weights` can be pickled
       and unpickled from uvicorn, FastAPI tests, or a notebook kernel
       interchangeably.

    2. The shipped `similarity_bundle.joblib` is generated WITHOUT the
       fitted pipeline.  At inference we only ever read `df` and
       `similarity_matrix`; the fitted pipeline is dead weight and was
       the only thing carrying the bad `__main__.` reference.  See
       `scripts/build_similarity_bundle.py`.
"""

from __future__ import annotations

from functools import partial
from typing import Iterable

import numpy as np
from sklearn.preprocessing import FunctionTransformer


# Stable per-feature weights. Exported as a dict-of-floats so it pickles
# identically across processes (no NumPy-version boxing quirks). Keep
# this table in lock-step with `Content_based_recomaendation.ipynb`
# cell #3bcef360.
DEFAULT_FEATURE_WEIGHTS: dict[str, float] = {
    "Chipset_Generation": 2.0,
    "CPU_max_clock_ghz": 1.8,
    "GPU_Is_Flagship": 1.8,
    "RAM_GB": 1.5,
    "Storage_GB": 1.3,
    "Battery_mAh": 1.3,
    "AnTuTu_Score": 1.6,
    "GeekBench_Score": 1.4,
    "Color_Option_Count": 0.3,
    "FM_Has_RDS": 0.2,
    "FM_Can_Record": 0.2,
}


def apply_weights(X: np.ndarray, weight_vector: np.ndarray) -> np.ndarray:
    """Multiply each column of ``X`` by its per-feature weight.

    Pure function — no closure, no free variables.  Takes the weight
    vector as an argument so the caller controls it.  This makes the
    function safe to pickle as a ``FunctionTransformer(func=...)`` target
    from any Python process.

    Shape contract::

        X               (n_samples, n_features) numeric matrix
        weight_vector   (n_features,)            per-column multipliers
        returns         X * weight_vector        element-wise product
    """
    weight_vector_arr = np.asarray(weight_vector, dtype=np.float64)
    if weight_vector_arr.ndim != 1:
        raise ValueError(
            f"weight_vector must be 1-D, got shape {weight_vector_arr.shape}"
        )
    if weight_vector_arr.shape[0] != X.shape[1]:
        raise ValueError(
            f"weight_vector length {weight_vector_arr.shape[0]} does not "
            f"match X feature count {X.shape[1]}"
        )
    return X * weight_vector_arr


def build_weight_vector(feature_names: Iterable[str]) -> np.ndarray:
    """For each column in ``feature_names``, look up the per-feature weight
    in ``DEFAULT_FEATURE_WEIGHTS``. Default is 1.0 (unweighted)."""
    return np.asarray(
        [DEFAULT_FEATURE_WEIGHTS.get(name, 1.0) for name in feature_names],
        dtype=np.float64,
    )


def make_apply_weights_step(
    weight_vector: np.ndarray,
) -> FunctionTransformer:
    """Return a sklearn ``FunctionTransformer`` whose ``func`` is a
    ``functools.partial`` of :func:`apply_weights`.

    Partial pickles correctly across processes because ``pickle`` records
    partials by their fully-qualified target function (``apply_weights``
    lives in this module, so unpickling finds it as long as ``pipeline/``
    is on ``sys.path``).

    Use this only at *fit* time.  The shipped ``similarity_bundle.joblib``
    does not include any fitted ``FunctionTransformer`` (see Layer B in
    the module docstring) — inference reads the pre-computed
    ``similarity_matrix`` directly.
    """
    return FunctionTransformer(
        func=partial(apply_weights, weight_vector=weight_vector),
        validate=False,
        accept_sparse=False,
    )
