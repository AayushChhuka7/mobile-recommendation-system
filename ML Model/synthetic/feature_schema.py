"""Feature schema for the synthetic customer dataset.

Defines the 35-column schema used by the synthetic generator. Each entry stores:
    - dtype (numpy / pandas type)
    - the value range or category set
    - "role": one of {identity, demographic, budget, interest, hardware,
      behavioural, engagement, ground_truth}
    - "in_cluster": whether the column should be fed to a downstream
      clustering algorithm. Identity / ground-truth columns are NOT.

The schema mirrors what the existing customer-segmentation notebook needs
plus the additional `gaming_interest` / `camera_interest` / etc. axes that
the segmentation prompt at README_CUSTOMER_SEGMENTATION.md specifies.

Reusing this module from notebooks or scripts:
    from synthetic.feature_schema import COLUMNS, CLUSTERING_FEATURES
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple


# ---------------------------------------------------------------------------
# Schema entry dataclass
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ColumnSpec:
    name: str
    role: str            # one of: identity, demographic, budget, interest,
                         #         hardware, behavioural, engagement, ground_truth
    dtype: str           # human-readable: "int", "float", "category"
    # For numeric columns:
    range_min: float | None = None
    range_max: float | None = None
    # For categorical columns:
    categories: Tuple[str, ...] | None = None
    # Whether this column is used as a feature when clustering.
    in_cluster: bool = True
    # A short description for the JSON schema export.
    description: str = ""


# ---------------------------------------------------------------------------
# Helpers — derive categorical pools from a single source of truth.
# ---------------------------------------------------------------------------
GENDERS: Tuple[str, ...] = ("Male", "Female", "Other")
CITY_TIERS: Tuple[str, ...] = ("tier_1", "tier_2", "rural")
CHIPSET_TIERS: Tuple[str, ...] = ("Budget", "Mid", "Flagship", "Flagship-Killer")
INTERACTION_CHANNELS: Tuple[str, ...] = (
    "Mobile App", "Daraz", "WhatsApp", "Instagram DM",
    "In-store", "Email", "Website",
)
# Brand pool — matches the top brands observed in dataset/customer_dataset.csv
# plus a few synthetic-only ones (Google, ASUS, Redmi) that are common in the
# segmentation prompt examples.
BRANDS: Tuple[str, ...] = (
    "Apple", "Samsung", "Xiaomi", "Vivo", "Oneplus", "Huawei",
    "Oppo", "Realme", "Infinix", "Tecno", "Honor", "Nokia",
    "Motorola", "Google", "ASUS", "Redmi",
)
# Cities — a curated set of Nepali cities (matches the customer_dataset.csv
# distribution). Truncated to the most common; generator samples uniformly.
CITIES: Tuple[str, ...] = (
    "Kathmandu", "Pokhara", "Lalitpur", "Bharatpur", "Biratnagar",
    "Birgunj", "Dharan", "Hetauda", "Itahari", "Janakpur",
    "Butwal", "Mahendranagar", "Dhangadhi", "Nepalgunj", "Gorkha",
    "Tansen", "Bhairahawa", "Damak", "Birtamod", "Siddharthanagar",
    "Lahan", "Rajbiraj", "Siraha", "Janakpur", "Jaleshwar",
    "Malangwa", "Gaur", "Kalaiya", "Simara", "Parasi",
    "Taulihawa", "Kapilvastu", "Krishnanagar", "Baglung", "Myagdi",
    "Beni", "Kusma", "Phalebas", "Galyang", "Waling",
    "Putalibazar", "Syangja", "Tanahun", "Damauli", "Bandipur",
    "Gorkha", "Barpak", "Saurpani", "Aarughat", "Palungtar",
    "Chitwan", "Rampur", "Parsa", "Bara", "Rautahat",
    "Sarlahi", "Mahottari", "Dhanusha", "Morang", "Sunsari",
    "Jhapa", "Ilam", "Bhojpur", "Dhankuta", "Terhathum",
    "Panchthar", "Taplejung", "Sankhuwasabha", "Bajhang", "Baitadi",
    "Dadeldhura", "Doti", "Achham", "Kailali", "Kanchanpur",
    "Humla", "Mugu", "Jumla", "Dolpa", "Rasuwa",
    "Sindhupalchowk", "Dolakha", "Ramechhap", "Sindhuli", "Kavrepalanchok",
    "Bhaktapur", "Makwanpur", "Rasuwa", "Manang", "Mustang",
    "Lamjung", "Kaski", "Parbat", "Myagdi",
)
# First / last names — Nepali-style names so the dataset feels authentic.
FIRST_NAMES: Tuple[str, ...] = (
    "Aayan", "Suresh", "Ankit", "Sandesh", "Ambika", "Shankar",
    "Sita", "Ram", "Hari", "Gita", "Krishna", "Saraswati",
    "Bishnu", "Laxmi", "Mahendra", "Parvati", "Deepak", "Kamala",
    "Rajesh", "Sunita", "Ramesh", "Anita", "Dinesh", "Sabita",
    "Prakash", "Manisha", "Manoj", "Rekha", "Santosh", "Pooja",
    "Bibek", "Asha", "Bibash", "Nirmala", "Sudip", "Sarita",
    "Aayush", "Homraj", "Sudeept", "Prakriti", "Sushant", "Anjali",
)
LAST_NAMES: Tuple[str, ...] = (
    "Khadka", "Chhuka", "Bhandari", "Tamang", "Limbu", "Simkhada",
    "Gurung", "Magar", "Rai", "Sherpa", "Thapa", "Shrestha",
    "Pradhan", "Tuladhar", "Maharjan", "Joshi", "Pandey", "Aryal",
    "Karki", "Basnet", "Dahal", "Acharya", "Adhikari", "Kafle",
    "Subedi", "Poudel", "K.C.", "Bohara", "Rana", "Singh",
    "Yadav", "Sah", "Mahato", "Tiwari", "Upadhyay", "Bhattarai",
    "Parajuli", "Neupane", "Dangol", "Manandhar", "Awale",
)


# ---------------------------------------------------------------------------
# Master column list — order = order in the CSV output
# ---------------------------------------------------------------------------
COLUMNS: List[ColumnSpec] = [
    # -- Identity (2) — never used in clustering
    ColumnSpec("customer_id", "identity", "category",
               categories=("syn_u_00000", "syn_u_99999"),
               in_cluster=False,
               description="Synthetic customer id, zero-padded 5 digits"),
    ColumnSpec("customer_name", "identity", "category",
               categories=("Aayan Khadka",),  # any of FIRST x LAST
               in_cluster=False,
               description="Random first + last name; display only"),

    # -- Demographics (5)
    ColumnSpec("age", "demographic", "int",
               range_min=18, range_max=75,
               description="Age in years"),
    ColumnSpec("gender", "demographic", "category",
               categories=GENDERS,
               description="Self-reported gender"),
    ColumnSpec("city", "demographic", "category",
               categories=CITIES,
               description="Nepali city"),
    ColumnSpec("country", "demographic", "category",
               categories=("Nepal",),
               in_cluster=False,  # constant — useless for clustering
               description="Always Nepal"),
    ColumnSpec("city_tier", "demographic", "category",
               categories=CITY_TIERS,
               description="Kathmandu valley → tier_1, others tier_2 / rural"),

    # -- Budget & Brand (4)
    ColumnSpec("budget_min_npr", "budget", "float",
               range_min=8_000, range_max=50_000,
               description="Minimum acceptable phone price, NPR"),
    ColumnSpec("budget_max_npr", "budget", "float",
               range_min=25_000, range_max=300_000,
               description="Maximum acceptable phone price, NPR"),
    ColumnSpec("preferred_brand", "budget", "category",
               categories=BRANDS,
               description="Brand the customer prefers"),
    ColumnSpec("brand_loyalty_score", "budget", "float",
               range_min=0.4, range_max=1.0,
               description="Probability of staying with preferred brand"),

    # -- Interest scores (7) — the primary clustering axes
    ColumnSpec("gaming_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = dislikes gaming phones, 100 = hardcore"),
    ColumnSpec("camera_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = camera doesn't matter, 100 = mobile photographer"),
    ColumnSpec("battery_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = any battery ok, 100 = battery life paramount"),
    ColumnSpec("display_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = any display ok, 100 = display enthusiast"),
    ColumnSpec("performance_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = entry-level ok, 100 = flagship performance"),
    ColumnSpec("software_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = don't care about updates / OS, 100 = must have latest"),
    ColumnSpec("value_interest", "interest", "float",
               range_min=0, range_max=100,
               description="0 = price insensitive, 100 = extreme bargain hunter"),

    # -- Hardware preferences (5) — internally consistent with interests
    ColumnSpec("min_ram_gb", "hardware", "int",
               range_min=4, range_max=16,
               description="Minimum acceptable RAM"),
    ColumnSpec("min_storage_gb", "hardware", "int",
               range_min=32, range_max=512,
               description="Minimum acceptable storage"),
    ColumnSpec("chipset_tier", "hardware", "category",
               categories=CHIPSET_TIERS,
               description="Required chipset class"),
    ColumnSpec("min_refresh_rate_hz", "hardware", "int",
               range_min=60, range_max=144,
               description="Minimum acceptable display refresh rate"),
    ColumnSpec("min_battery_mah", "hardware", "int",
               range_min=3000, range_max=7000,
               description="Minimum acceptable battery capacity"),

    # -- Behavioural / RFM (6)
    ColumnSpec("purchase_frequency_per_year", "behavioural", "float",
               range_min=0.5, range_max=6.0,
               description="Phones bought per year"),
    ColumnSpec("n_past_purchases", "behavioural", "int",
               range_min=0, range_max=10,
               description="Lifetime phone purchases"),
    ColumnSpec("avg_session_minutes", "behavioural", "float",
               range_min=1, range_max=60,
               description="Average browsing session length"),
    ColumnSpec("search_freq_per_week", "behavioural", "int",
               range_min=0, range_max=50,
               description="Searches / week"),
    ColumnSpec("compare_freq_per_week", "behavioural", "int",
               range_min=0, range_max=25,
               description="Phone-vs-phone comparisons / week"),
    ColumnSpec("click_through_rate", "behavioural", "float",
               range_min=0, range_max=1,
               description="Recs clicked / recs shown"),

    # -- Engagement & channel (5)
    ColumnSpec("recency_days", "engagement", "int",
               range_min=0, range_max=720,
               description="Days since last activity (0 = very recent)"),
    ColumnSpec("avg_rating_given", "engagement", "float",
               range_min=1, range_max=5,
               description="Average star rating left on past phones"),
    ColumnSpec("interaction_channel", "engagement", "category",
               categories=INTERACTION_CHANNELS,
               description="Channel they most often interact through"),
    ColumnSpec("wishlist_conversion_rate", "engagement", "float",
               range_min=0, range_max=1,
               description="Wishlist items eventually bought / total wishlisted"),
    ColumnSpec("accessory_affinity", "engagement", "float",
               range_min=0, range_max=1,
               description="Probability of buying accessories with phone"),

    # -- Ground truth (1) — never used in clustering
    ColumnSpec("true_archetype", "ground_truth", "category",
               categories=("Hardcore Gamer", "Mobile Photographer",
                           "Budget Buyer", "Premium Flagship User",
                           "Battery-Focused User", "Brand-Loyal Customer",
                           "All-Round User", "Display Enthusiast"),
               in_cluster=False,
               description="Ground-truth archetype label — for validation only"),
]


# ---------------------------------------------------------------------------
# Convenience lookups
# ---------------------------------------------------------------------------
COLUMN_BY_NAME: Dict[str, ColumnSpec] = {c.name: c for c in COLUMNS}

# Columns a downstream clustering algorithm should consume.
CLUSTERING_FEATURES: List[str] = [c.name for c in COLUMNS if c.in_cluster]

# Columns of dtype int / float (i.e. numeric features — usable as-is after scaling).
NUMERIC_FEATURES: List[str] = [c.name for c in COLUMNS
                               if c.in_cluster and c.dtype in ("int", "float")]

# Categorical columns that need one-hot or ordinal encoding before clustering.
CATEGORICAL_FEATURES: List[str] = [c.name for c in COLUMNS
                                   if c.in_cluster and c.dtype == "category"]

# Names of the seven interest scores — primary segmentation axes.
INTEREST_SCORES: Tuple[str, ...] = (
    "gaming_interest", "camera_interest", "battery_interest",
    "display_interest", "performance_interest", "software_interest",
    "value_interest",
)


def to_json_schema() -> Dict:
    """Export the schema as a JSON-serializable dict (for documentation)."""
    return {
        "n_columns": len(COLUMNS),
        "n_clustering_features": len(CLUSTERING_FEATURES),
        "n_numeric_features": len(NUMERIC_FEATURES),
        "n_categorical_features": len(CATEGORICAL_FEATURES),
        "columns": [
            {
                "name": c.name, "role": c.role, "dtype": c.dtype,
                "range_min": c.range_min, "range_max": c.range_max,
                "categories": list(c.categories) if c.categories else None,
                "in_cluster": c.in_cluster, "description": c.description,
            }
            for c in COLUMNS
        ],
        "clustering_features": CLUSTERING_FEATURES,
        "interest_scores": list(INTEREST_SCORES),
    }