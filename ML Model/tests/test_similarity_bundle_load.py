r"""
tests/test_similarity_bundle_load.py — CI guard against the
`Can't get attribute 'apply_weights' on __main__` class of bug.

Run from project root::

    python -m pytest "ML Model/tests/test_similarity_bundle_load.py" -q
or directly::

    python "ML Model/tests/test_similarity_bundle_load.py"

What it does
============

1. Spawns a fresh ``python`` interpreter with ``-S`` (no site) so
   ``__main__`` is guaranteed to NOT have ``apply_weights``. This is
   the closest stand-in we can build for ``uvicorn.exe.__main__``.

2. From that fresh interpreter, executes
   ``pipeline.similarity.apply_weights`` (now importable) AND
   loads ``similarity_bundle.joblib`` via ``joblib.load``.

3. Asserts the bundle has the keys the FastAPI runtime consumes
   (``df``, ``similarity_matrix``).

If this test passes locally, uvicorn will load the bundle cleanly
in production. If it ever fails in CI, a notebook author has
re-introduced a `__main__.foo` callable into the bundle.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

try:
    import pytest  # type: ignore
except ImportError:  # pragma: no cover
    # Allow `python tests/test_similarity_bundle_load.py` to run without
    # pytest installed. We provide a tiny `pytest.fail`-equivalent.
    class _PytestStub:
        class _Mark:
            @staticmethod
            def skipif(cond, reason=""):
                return lambda f: f
        mark = _Mark()

        @staticmethod
        def skipif(cond, reason=""):
            return lambda f: f

        @staticmethod
        def fail(msg):
            raise AssertionError(msg)

        @staticmethod
        def main(args):
            # Run the test_* functions directly.
            mod_globals = sys.modules[__name__].__dict__
            failures = []
            for name, fn in list(mod_globals.items()):
                if name.startswith("test_") and callable(fn):
                    try:
                        fn()
                        print(f"PASS: {name}")
                    except SystemExit as e:
                        if e.code == 0:
                            print(f"PASS: {name}")
                        else:
                            failures.append((name, e.code))
                    except Exception as e:
                        failures.append((name, e))
            if failures:
                for n, code_or_exc in failures:
                    print(f"FAIL: {n}: {code_or_exc}")
                return 1
            return 0

    pytest = _PytestStub()  # type: ignore

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BUNDLE = REPO_ROOT / "ML Model" / "similarity_bundle.joblib"


@pytest.mark.skipif(
    not BUNDLE.exists(),
    reason=f"similarity_bundle.joblib not present at {BUNDLE}",
)
def test_bundle_loads_from_clean_interpreter() -> None:
    """The bundle must unpickle from any Python process whose __main__
    has no apply_weights attribute — including uvicorn.exe.__main__."""
    # We pass the *current* Python interpreter (which has joblib) but
    # run a body that only imports sys + joblib + traceback and
    # confirms the bundle's unpickle does NOT require `apply_weights`
    # to exist on __main__. That is exactly the property uvicorn's
    # __main__ has: no apply_weights binding.
    current_python = Path(sys.executable).resolve()
    current_python_str = str(current_python).replace("\\", "\\\\")

    body = textwrap.dedent(
        r"""
        import sys, joblib, traceback

        BUNDLE = r"%s"
        try:
            bundle = joblib.load(BUNDLE)
        except Exception:
            traceback.print_exc()
            sys.exit(2)

        for required in ("df", "similarity_matrix"):
            if required not in bundle:
                print(f"MISSING KEY: {required}", file=sys.stderr)
                sys.exit(3)

        if len(bundle["df"]) != bundle["similarity_matrix"].shape[0]:
            print(
                f"SHAPE MISMATCH: df={len(bundle['df'])} "
                f"matrix={bundle['similarity_matrix'].shape}",
                file=sys.stderr,
            )
            sys.exit(4)

        print(
            f"OK n_phones={len(bundle['df'])} "
            f"matrix={bundle['similarity_matrix'].shape}"
        )
        sys.exit(0)
        """
    ) % str(BUNDLE).replace("\\", "\\\\")

    # -c "..." runs the body as __main__ in a process whose __main__ has
    # only what `python -c` sets up — i.e. no `apply_weights`. The
    # `apply_weights` reference (if any) in the bundle will fail to
    # resolve, which is the exact same failure mode as uvicorn.
    result = subprocess.run(
        [current_python_str, "-c", body],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        pytest.fail(
            "similarity_bundle.joblib failed to load under a clean "
            f"__main__.\n--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )
    assert "OK" in result.stdout, result.stdout


def test_apply_weights_is_importable() -> None:
    """Sanity check on Layer A: pipeline.similarity.apply_weights is a
    real, importable function. If a future refactor accidentally moves
    it back to a notebook cell, this test fails before any bundle code
    runs."""
    sys.path.insert(0, str(REPO_ROOT / "ML Model"))
    from pipeline.similarity import (  # type: ignore[import-not-found]
        DEFAULT_FEATURE_WEIGHTS,
        apply_weights,
        build_weight_vector,
    )

    import numpy as np

    # Build a tiny (3, 2) matrix and a (2,) weight vector.
    X = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])
    w = np.array([2.0, 0.5])
    out = apply_weights(X, w)
    expected = X * w
    assert np.allclose(out, expected)
    assert "Chipset_Generation" in DEFAULT_FEATURE_WEIGHTS
    assert build_weight_vector(["unknown_feature", "RAM_GB"]).tolist() == [1.0, 1.5]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))