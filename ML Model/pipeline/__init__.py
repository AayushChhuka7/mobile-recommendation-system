"""Mobile Recommendation ML Pipeline.

Refactored from `ML Model/EDA_and_Feature_Engineering_to_Dataset.ipynb`
into reusable, importable modules so the model + scoring + recommendation
engine can be served to the Node/Express backend via a thin FastAPI wrapper.

Public API:
    MobileRecommendationPipeline -- the main class (load → predict / score / recommend).
    PersonaType                 -- enum of user personas (Gamer / Camera_Lover / …).
    UserPreferenceInput         -- dataclass the UI/API fills in.
    recommend                   -- the ranking function (lifted from cell 104).
"""

from .model import MobileRecommendationPipeline
from .recommend import (
    PersonaType,
    UserPreferenceInput,
    PERSONA_PRESETS,
    SCORE_DIMENSIONS,
    score_cols_map as SCORE_COLS_MAP,
    recommend as recommend_phones,
)
from .scoring import ScoringSnapshot, compute_scores

__all__ = [
    "MobileRecommendationPipeline",
    "PersonaType",
    "UserPreferenceInput",
    "PERSONA_PRESETS",
    "SCORE_DIMENSIONS",
    "SCORE_COLS_MAP",
    "ScoringSnapshot",
    "compute_scores",
    "recommend_phones",
]
