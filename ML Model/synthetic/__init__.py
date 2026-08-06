"""Synthetic customer dataset generator.

Mirrors the convention of ``pipeline/__init__.py``: re-export the public API
so downstream notebooks can write ``from synthetic import generate`` rather
than reaching into private submodules.

Public API
----------
generate(n_users, seed)
    Generate a fresh synthetic-customer DataFrame.
write_outputs(df, output_csv, ...)
    Write the DataFrame to CSV + JSON schema + per-archetype summary.
validate_dataset(csv_path)  -> dict
    Run every internal-consistency check, return a JSON-serializable report.
ARCHETYPES, ARCHETYPE_WEIGHTS
    The eight customer archetype specs and their population weights.
COLUMNS, CLUSTERING_FEATURES, NUMERIC_FEATURES, CATEGORICAL_FEATURES, INTEREST_SCORES
    Column metadata from feature_schema.py.
to_json_schema()
    Export the column metadata as a JSON-serializable dict (for docs).
"""

from .archetypes import ARCHETYPES, ARCHETYPE_WEIGHTS, ArchetypeSpec
from .feature_schema import (
    CATEGORICAL_FEATURES,
    CLUSTERING_FEATURES,
    COLUMNS,
    INTEREST_SCORES,
    NUMERIC_FEATURES,
    to_json_schema,
)
from .generator import generate, write_outputs

__all__ = [
    "ARCHETYPES",
    "ARCHETYPE_WEIGHTS",
    "ArchetypeSpec",
    "COLUMNS",
    "CLUSTERING_FEATURES",
    "NUMERIC_FEATURES",
    "CATEGORICAL_FEATURES",
    "INTEREST_SCORES",
    "generate",
    "write_outputs",
    "to_json_schema",
]
