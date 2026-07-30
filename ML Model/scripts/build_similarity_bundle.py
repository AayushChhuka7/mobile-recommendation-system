"""
scripts/build_similarity_bundle.py — regenerate `similarity_bundle.joblib`.

This is the one-shot fix for the
``AttributeError: Can't get attribute 'apply_weights' on __main__``
error you get when uvicorn / FastAPI tries to load the old bundle.
The previous bundle serialised a fitted sklearn pipeline that
contained ``FunctionTransformer(func=apply_weights)`` where
``apply_weights`` was a notebook-cell closure. Pickle recorded it as
``__main__.apply_weights`` — unimportable from any process whose
``__main__`` isn't the notebook kernel.

The bundle shipped by this script is **smaller on purpose**: it drops
the fitted pipeline, since at runtime we only ever read
``similarity_matrix`` and ``df`` (see ``pipeline/serve.py::
_load_similarity_bundle``). Dropping the pipeline eliminates the bad
reference entirely.

What the new bundle contains:

    - df                  pandas.DataFrame, brand + model metadata
    - similarity_matrix   np.ndarray, N×N cosine similarity (already
                          encodes the training-time weights)
    - feature_weights     dict, the per-feature weight table
    - n_phones            int, len(df) for health checks
    - similarity_dim      int, matrix.shape[0] for health checks

API contract unchanged. ``/similarity/score`` reads the same keys from
``bundle`` as before.

Usage::

    python scripts/build_similarity_bundle.py
    python scripts/build_similarity_bundle.py --csv ./After_EDA_and_Feature_ENginering.csv
    python scripts/build_similarity_bundle.py --out /tmp/similarity_bundle.joblib

Optional ``--prefer-existing``: skip the (slow) recompute and just
trim the existing bundle to the safe keys. Fast path when you just
need to drop the broken pipeline.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pipeline.similarity import DEFAULT_FEATURE_WEIGHTS  # noqa: E402

DEFAULT_CSV = PROJECT_ROOT / "After_EDA_and_Feature_ENginering.csv"
DEFAULT_OUT = PROJECT_ROOT / "similarity_bundle.joblib"
EXISTING_BUNDLE = PROJECT_ROOT / "similarity_bundle.joblib"


def _trim_existing_bundle(src: Path, dst: Path) -> None:
    """Open the existing bundle once via ``pickle`` (we don't have a
    loader that handles __main__ refs, but we can read raw bytes and
    delete the offending tree by re-dumping only the safe keys).

    Implementation: load in a clean Python process where __main__ is
    *this* script. Then simply re-dump the safe keys. We cannot undo
    the closure ref by editing pickle bytes; we can only avoid it by
    not re-pickling the fitted pipeline.
    """
    print(f"[build_similarity_bundle] trimming {src} (keeping safe keys only)")
    bundle = joblib.load(src)
    safe = _safe_bundle(bundle)
    joblib.dump(safe, dst)
    print(
        f"[build_similarity_bundle] wrote {dst} "
        f"(n_phones={safe['n_phones']}, matrix={safe['similarity_matrix'].shape})"
    )


def _safe_bundle(bundle: dict) -> dict:
    """Filter a loaded bundle down to the runtime-safe keys."""
    df = bundle.get("df")
    sim = bundle.get("similarity_matrix")
    fw = bundle.get("feature_weights") or dict(DEFAULT_FEATURE_WEIGHTS)
    if df is None or sim is None:
        raise ValueError(
            "Existing bundle is missing required keys 'df' or 'similarity_matrix'"
        )
    return {
        "df": df,
        "similarity_matrix": np.asarray(sim, dtype=np.float64),
        "feature_weights": dict(fw),
        "n_phones": int(len(df)),
        "similarity_dim": int(np.asarray(sim).shape[0]),
    }


def _rebuild_from_csv(csv_path: Path, out_path: Path) -> None:
    """Re-derive df + similarity_matrix from the engineered CSV. Use this
    when the existing bundle is broken beyond trimming."""
    print(f"[build_similarity_bundle] reading {csv_path} …", flush=True)
    df = pd.read_csv(csv_path)

    # Mirror the notebook's preprocess-and-clean steps.
    provenance_cols = [
        c for c in df.columns if c.endswith("_Source") or c.endswith("_is_imputed")
    ]
    df = df.drop(columns=provenance_cols)
    df = df.replace([np.inf, -np.inf], np.nan)
    df = (
        df.sort_values("Price_EUR")
          .drop_duplicates(subset=["Brand", "Model_Name"], keep="first")
          .reset_index(drop=True)
    )


    print(
        f"[build_similarity_bundle] df shape after clean: {df.shape}",
        flush=True,
    )

    # NOTE — to keep this script runnable without the giant precomputed
    # `phone_matrix.npy` (which the notebook writes once during
    # training), we recompute `phone_matrix` here from scratch. This is
    # a faithful copy of cells 95234e27 → 55dc7abf in
    # Content_based_recomaendation.ipynb.
    numerical_feature = [
        c for c in df.columns if df[c].dtype in ["float64", "float32", "int64", "int32"]
    ]
    categorical_feature = [
        c for c in df.columns if df[c].dtype in ["object", "category", "string"]
    ]
    categorical_feature = [c for c in categorical_feature if c != "Model_Name"]

    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.metrics.pairwise import cosine_similarity
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    # Use the importable, pickle-safe pipeline.similarity helper.
    from pipeline.similarity import build_weight_vector, make_apply_weights_step

    weight_vector = build_weight_vector(numerical_feature)

    numeric_pipeline = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("weight", make_apply_weights_step(weight_vector)),
        ]
    )
    categorical_pipeline = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="constant", fill_value="Unknown")),
            ("encode", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    preprocessor = ColumnTransformer(
        transformers=[
            ("num", numeric_pipeline, numerical_feature),
            ("cat", categorical_pipeline, categorical_feature),
        ]
    )

    print("[build_similarity_bundle] fitting preprocessor …", flush=True)
    phone_matrix = preprocessor.fit_transform(df)
    print(
        f"[build_similarity_bundle] phone_matrix shape: {phone_matrix.shape}",
        flush=True,
    )

    similarity_matrix = cosine_similarity(phone_matrix)
    print(
        f"[build_similarity_bundle] similarity_matrix shape: "
        f"{similarity_matrix.shape}",
        flush=True,
    )

    safe = {
        "df": df,
        "similarity_matrix": np.asarray(similarity_matrix, dtype=np.float64),
        "feature_weights": dict(DEFAULT_FEATURE_WEIGHTS),
        "n_phones": int(len(df)),
        "similarity_dim": int(similarity_matrix.shape[0]),
    }
    print(f"[build_similarity_bundle] writing {out_path} …", flush=True)
    joblib.dump(safe, out_path)
    print("[build_similarity_bundle] done.", flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument(
        "--prefer-existing",
        action="store_true",
        help=(
            "If the existing similarity_bundle.joblib is present, "
            "trim it to safe keys instead of recomputing from CSV. "
            "Fast path for the production fix."
        ),
    )
    args = p.parse_args()

    if args.prefer_existing and EXISTING_BUNDLE.exists():
        # We cannot joblib.load the broken bundle here because this
        # process would still try to import __main__.apply_weights.
        # Solution: use a subprocess to load+trim+save, so the trim
        # happens under this script's __main__ (where apply_weights
        # is unknown — but that's fine because we don't unpack the
        # fitted pipeline at all).
        import subprocess

        trim_script = PROJECT_ROOT / "scripts" / "_trim_similarity_bundle.py"
        trim_script.parent.mkdir(parents=True, exist_ok=True)
        trim_script.write_text(
            "import sys\n"
            f"sys.path.insert(0, r'{PROJECT_ROOT}')\n"
            "import joblib, numpy as np\n"
            "src, dst = sys.argv[1], sys.argv[2]\n"
            "bundle = joblib.load(src)\n"
            "df = bundle['df']; sim = bundle['similarity_matrix']\n"
            "fw = bundle.get('feature_weights') or {}\n"
            "joblib.dump({\n"
            "    'df': df,\n"
            "    'similarity_matrix': np.asarray(sim, dtype=np.float64),\n"
            "    'feature_weights': dict(fw),\n"
            "    'n_phones': int(len(df)),\n"
            "    'similarity_dim': int(np.asarray(sim).shape[0]),\n"
            "}, dst)\n"
            "print(f'trimmed: n_phones={len(df)}, matrix={sim.shape}')\n",
            encoding="utf-8",
        )
        # Run the trim script under a fresh Python that doesn't have
        # apply_weights on __main__ — we deliberately do NOT use this
        # script's process.
        result = subprocess.run(
            [
                sys.executable,
                str(trim_script),
                str(EXISTING_BUNDLE),
                str(args.out),
            ],
            cwd=str(PROJECT_ROOT),
            check=False,
        )
        if result.returncode == 0:
            print(f"[build_similarity_bundle] wrote {args.out}")
            return 0
        print(
            "[build_similarity_bundle] trim failed; falling back to CSV rebuild",
            file=sys.stderr,
        )

    if not args.csv.exists():
        print(f"FATAL: CSV not found at {args.csv}", file=sys.stderr)
        return 2

    _rebuild_from_csv(args.csv, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
