"""Eight customer archetypes — each one an internally consistent persona.

Each archetype spec is a dict containing:
    - the seven interest-score centroids (0-100)
    - hardware preferences (RAM / storage / chipset tier / refresh / battery)
    - a brand preference (with optional weights over a brand pool)
    - age range
    - city-tier weights (Premium → tier_1, Budget → rural)
    - gender weights
    - budget range (NPR)
    - default behavioural / engagement values

The whole dataset is sampled by:
    1. pick an archetype using ARCHETYPE_WEIGHTS
    2. sample demographics (age, city_tier, gender) from spec ranges
    3. sample budget / preferred_brand from spec ranges
    4. sample the seven interest scores from the spec centroid + Gaussian noise
    5. sample hardware preferences consistent with the interest scores
       (e.g. a Gamer with gaming_interest≥85 always gets refresh_rate≥120)
    6. sample behavioural / engagement from spec defaults + noise

The "internal consistency" promise is what makes these clusters recoverable
by K-Means — a Gamer row's refresh_rate IS high because its gaming_interest IS
high, not by coincidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple


# ---------------------------------------------------------------------------
# Archetype specification dataclass
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ArchetypeSpec:
    """A single archetype — the centroid values + sampling ranges per row."""

    # Human-readable name — matches README_CUSTOMER_SEGMENTATION.md.
    name: str

    # Population share among the synthetic user base (fraction).
    weight: float

    # Interest-score centroids on a 0-100 scale.
    # Values <30 / >70 produce distinct clusters; mid-range values (~50) blend in.
    interests: Dict[str, float] = field(default_factory=dict)

    # Hardware preference centroids.
    chipset_tier: str = "Mid"             # "Budget" | "Mid" | "Flagship" | "Flagship-Killer"
    min_ram_gb: int = 6
    min_storage_gb: int = 128
    min_refresh_rate_hz: int = 90
    min_battery_mah: int = 4500

    # Brand preferences — either a single brand or a weighted list of candidates.
    # Weights are relative; they sum to 1.
    brands: Tuple[Tuple[str, float], ...] = ()

    # Demographics.
    age_range: Tuple[int, int] = (25, 50)
    city_tier_weights: Tuple[Tuple[str, float], ...] = ()
    gender_weights: Tuple[Tuple[str, float], ...] = ()

    # Budget — minimum and maximum acceptable phone price in NPR.
    budget_min_npr: int = 20_000
    budget_max_npr: int = 80_000

    # Brand-loyalty score (0.4 = indifferent, 0.95 = strict loyalist).
    brand_loyalty_score: float = 0.6

    # Behavioural defaults.
    purchase_frequency_per_year: float = 2.0
    n_past_purchases: int = 2
    avg_session_minutes: float = 12.0
    search_freq_per_week: int = 8
    compare_freq_per_week: int = 4
    click_through_rate: float = 0.30

    # Engagement defaults.
    recency_days: int = 90
    avg_rating_given: float = 4.0
    interaction_channel_weights: Tuple[Tuple[str, float], ...] = ()
    wishlist_conversion_rate: float = 0.20
    accessory_affinity: float = 0.3

    def centroid_vector(self) -> List[float]:
        """Return the seven interest centroids as a numeric vector (for k-means)."""
        keys = ("gaming_interest", "camera_interest", "battery_interest",
                "display_interest", "performance_interest", "software_interest",
                "value_interest")
        return [self.interests[k] for k in keys]


# ---------------------------------------------------------------------------
# The 8 archetypes.
#
# Each spec is hand-tuned so the centroid vector is unique enough that a
# k-means style algorithm can recover them after ±10% Gaussian noise.
# ---------------------------------------------------------------------------
ARCHETYPES: Dict[str, ArchetypeSpec] = {

    # ── 1. Hardcore Gamer — 12% ────────────────────────────────────────────
    "Hardcore Gamer": ArchetypeSpec(
        name="Hardcore Gamer",
        weight=0.12,
        interests=dict(
            gaming_interest=92, camera_interest=30, battery_interest=70,
            display_interest=75, performance_interest=95,
            software_interest=40, value_interest=55,
        ),
        chipset_tier="Flagship",
        min_ram_gb=12,
        min_storage_gb=256,
        min_refresh_rate_hz=144,
        min_battery_mah=5500,
        brands=(("ASUS", 0.5), ("Oneplus", 0.3), ("Apple", 0.2)),
        age_range=(18, 30),
        city_tier_weights=(("tier_1", 0.6), ("tier_2", 0.3), ("rural", 0.1)),
        gender_weights=(("Male", 0.85), ("Female", 0.13), ("Other", 0.02)),
        budget_min_npr=40_000,
        budget_max_npr=180_000,
        brand_loyalty_score=0.65,
        purchase_frequency_per_year=2.5,
        n_past_purchases=3,
        avg_session_minutes=22.0,
        search_freq_per_week=18,
        compare_freq_per_week=10,
        click_through_rate=0.42,
        recency_days=45,
        avg_rating_given=4.1,
        interaction_channel_weights=(
            ("Mobile App", 0.45), ("Daraz", 0.25), ("Instagram DM", 0.15),
            ("WhatsApp", 0.10), ("In-store", 0.05),
        ),
        wishlist_conversion_rate=0.30,
        accessory_affinity=0.7,  # gaming controller, cooling fan, etc.
    ),

    # ── 2. Mobile Photographer — 14% ───────────────────────────────────────
    "Mobile Photographer": ArchetypeSpec(
        name="Mobile Photographer",
        weight=0.14,
        interests=dict(
            gaming_interest=25, camera_interest=96, battery_interest=50,
            display_interest=65, performance_interest=55,
            software_interest=60, value_interest=45,
        ),
        chipset_tier="Flagship",
        min_ram_gb=8,
        min_storage_gb=256,
        min_refresh_rate_hz=90,
        min_battery_mah=4500,
        brands=(("Google", 0.5), ("Apple", 0.4), ("Samsung", 0.1)),
        age_range=(25, 45),
        city_tier_weights=(("tier_1", 0.7), ("tier_2", 0.25), ("rural", 0.05)),
        gender_weights=(("Female", 0.55), ("Male", 0.43), ("Other", 0.02)),
        budget_min_npr=50_000,
        budget_max_npr=200_000,
        brand_loyalty_score=0.75,
        purchase_frequency_per_year=1.8,
        n_past_purchases=2,
        avg_session_minutes=18.0,
        search_freq_per_week=12,
        compare_freq_per_week=8,
        click_through_rate=0.35,
        recency_days=60,
        avg_rating_given=4.0,
        interaction_channel_weights=(
            ("Mobile App", 0.5), ("Instagram DM", 0.25), ("Daraz", 0.15),
            ("Website", 0.07), ("WhatsApp", 0.03),
        ),
        wishlist_conversion_rate=0.25,
        accessory_affinity=0.8,  # lens kit, tripod, ring light
    ),

    # ── 3. Budget Buyer — 22% ──────────────────────────────────────────────
    "Budget Buyer": ArchetypeSpec(
        name="Budget Buyer",
        weight=0.22,
        interests=dict(
            gaming_interest=35, camera_interest=40, battery_interest=70,
            display_interest=45, performance_interest=30,
            software_interest=40, value_interest=85,
        ),
        chipset_tier="Budget",
        min_ram_gb=4,
        min_storage_gb=64,
        min_refresh_rate_hz=60,
        min_battery_mah=5000,
        brands=(("Redmi", 0.4), ("Realme", 0.25), ("Samsung", 0.15),
                ("Infinix", 0.1), ("Tecno", 0.1)),
        age_range=(18, 35),
        city_tier_weights=(("tier_1", 0.30), ("tier_2", 0.40), ("rural", 0.30)),
        gender_weights=(("Male", 0.55), ("Female", 0.43), ("Other", 0.02)),
        budget_min_npr=8_000,
        budget_max_npr=30_000,
        brand_loyalty_score=0.55,
        purchase_frequency_per_year=1.2,
        n_past_purchases=1,
        avg_session_minutes=8.0,
        search_freq_per_week=15,
        compare_freq_per_week=12,
        click_through_rate=0.50,
        recency_days=120,
        avg_rating_given=3.7,
        interaction_channel_weights=(
            ("Daraz", 0.5), ("Mobile App", 0.25), ("WhatsApp", 0.10),
            ("In-store", 0.10), ("Instagram DM", 0.05),
        ),
        wishlist_conversion_rate=0.10,
        accessory_affinity=0.4,
    ),

    # ── 4. Premium Flagship User — 10% ─────────────────────────────────────
    "Premium Flagship User": ArchetypeSpec(
        name="Premium Flagship User",
        weight=0.10,
        interests=dict(
            gaming_interest=50, camera_interest=80, battery_interest=60,
            display_interest=82, performance_interest=90,
            software_interest=85, value_interest=40,
        ),
        chipset_tier="Flagship",
        min_ram_gb=8,
        min_storage_gb=256,
        min_refresh_rate_hz=120,
        min_battery_mah=4500,
        brands=(("Apple", 0.65), ("Samsung", 0.30), ("Google", 0.05)),
        age_range=(30, 55),
        city_tier_weights=(("tier_1", 0.85), ("tier_2", 0.13), ("rural", 0.02)),
        gender_weights=(("Male", 0.55), ("Female", 0.43), ("Other", 0.02)),
        budget_min_npr=80_000,
        budget_max_npr=300_000,
        brand_loyalty_score=0.85,
        purchase_frequency_per_year=2.8,
        n_past_purchases=4,
        avg_session_minutes=16.0,
        search_freq_per_week=10,
        compare_freq_per_week=6,
        click_through_rate=0.32,
        recency_days=30,
        avg_rating_given=4.3,
        interaction_channel_weights=(
            ("Mobile App", 0.55), ("Website", 0.20), ("Daraz", 0.15),
            ("In-store", 0.05), ("Email", 0.05),
        ),
        wishlist_conversion_rate=0.40,
        accessory_affinity=0.5,
    ),

    # ── 5. Battery-Focused User — 11% ──────────────────────────────────────
    "Battery-Focused User": ArchetypeSpec(
        name="Battery-Focused User",
        weight=0.11,
        interests=dict(
            gaming_interest=40, camera_interest=45, battery_interest=95,
            display_interest=50, performance_interest=55,
            software_interest=40, value_interest=65,
        ),
        chipset_tier="Mid",
        min_ram_gb=6,
        min_storage_gb=128,
        min_refresh_rate_hz=90,
        min_battery_mah=6500,
        brands=(("Samsung", 0.6), ("Xiaomi", 0.25), ("Tecno", 0.10),
                ("Motorola", 0.05)),
        age_range=(40, 65),
        city_tier_weights=(("tier_1", 0.30), ("tier_2", 0.40), ("rural", 0.30)),
        gender_weights=(("Male", 0.60), ("Female", 0.38), ("Other", 0.02)),
        budget_min_npr=20_000,
        budget_max_npr=70_000,
        brand_loyalty_score=0.7,
        purchase_frequency_per_year=1.5,
        n_past_purchases=2,
        avg_session_minutes=10.0,
        search_freq_per_week=8,
        compare_freq_per_week=5,
        click_through_rate=0.28,
        recency_days=180,
        avg_rating_given=3.9,
        interaction_channel_weights=(
            ("Mobile App", 0.35), ("In-store", 0.25), ("Daraz", 0.20),
            ("WhatsApp", 0.10), ("Email", 0.10),
        ),
        wishlist_conversion_rate=0.15,
        accessory_affinity=0.3,
    ),

    # ── 6. Brand-Loyal Customer — 13% ──────────────────────────────────────
    "Brand-Loyal Customer": ArchetypeSpec(
        name="Brand-Loyal Customer",
        weight=0.13,
        interests=dict(
            gaming_interest=45, camera_interest=55, battery_interest=55,
            display_interest=55, performance_interest=55,
            software_interest=50, value_interest=50,
        ),
        chipset_tier="Mid",
        min_ram_gb=6,
        min_storage_gb=128,
        min_refresh_rate_hz=90,
        min_battery_mah=4500,
        brands=(("Apple", 0.5), ("Samsung", 0.4), ("Oneplus", 0.1)),
        age_range=(25, 50),
        city_tier_weights=(("tier_1", 0.50), ("tier_2", 0.40), ("rural", 0.10)),
        gender_weights=(("Male", 0.55), ("Female", 0.43), ("Other", 0.02)),
        budget_min_npr=30_000,
        budget_max_npr=150_000,
        brand_loyalty_score=0.95,  # the distinctive feature
        purchase_frequency_per_year=1.5,
        n_past_purchases=3,
        avg_session_minutes=14.0,
        search_freq_per_week=6,
        compare_freq_per_week=3,
        click_through_rate=0.25,
        recency_days=200,
        avg_rating_given=4.4,  # they rate their favourite brand highly
        interaction_channel_weights=(
            ("Mobile App", 0.5), ("In-store", 0.20), ("Website", 0.15),
            ("Daraz", 0.10), ("Email", 0.05),
        ),
        wishlist_conversion_rate=0.50,  # high — they buy what they wishlist
        accessory_affinity=0.4,
    ),

    # ── 7. All-Round User — 10% ────────────────────────────────────────────
    "All-Round User": ArchetypeSpec(
        name="All-Round User",
        weight=0.10,
        interests=dict(
            gaming_interest=45, camera_interest=45, battery_interest=50,
            display_interest=50, performance_interest=45,
            software_interest=45, value_interest=70,
        ),
        chipset_tier="Mid",
        min_ram_gb=6,
        min_storage_gb=128,
        min_refresh_rate_hz=90,
        min_battery_mah=4500,
        # All-Round — uniform brand pull (we'll actually pick from a flat pool at sampling)
        brands=(("Samsung", 0.25), ("Xiaomi", 0.20), ("Oneplus", 0.15),
                ("Vivo", 0.10), ("Oppo", 0.10), ("Realme", 0.10),
                ("Honor", 0.05), ("Nokia", 0.05)),
        age_range=(25, 45),
        city_tier_weights=(("tier_1", 0.45), ("tier_2", 0.45), ("rural", 0.10)),
        gender_weights=(("Male", 0.52), ("Female", 0.46), ("Other", 0.02)),
        budget_min_npr=25_000,
        budget_max_npr=100_000,
        brand_loyalty_score=0.55,
        purchase_frequency_per_year=1.8,
        n_past_purchases=2,
        avg_session_minutes=12.0,
        search_freq_per_week=10,
        compare_freq_per_week=5,
        click_through_rate=0.30,
        recency_days=90,
        avg_rating_given=4.0,
        interaction_channel_weights=(
            ("Mobile App", 0.45), ("Daraz", 0.20), ("Website", 0.15),
            ("In-store", 0.10), ("WhatsApp", 0.05), ("Instagram DM", 0.05),
        ),
        wishlist_conversion_rate=0.25,
        accessory_affinity=0.4,
    ),

    # ── 8. Display Enthusiast — 8% ─────────────────────────────────────────
    "Display Enthusiast": ArchetypeSpec(
        name="Display Enthusiast",
        weight=0.08,
        interests=dict(
            gaming_interest=70, camera_interest=70, battery_interest=55,
            display_interest=95, performance_interest=75,
            software_interest=50, value_interest=35,
        ),
        chipset_tier="Flagship",
        min_ram_gb=8,
        min_storage_gb=256,
        min_refresh_rate_hz=144,
        min_battery_mah=4800,
        brands=(("Samsung", 0.5), ("Oneplus", 0.3), ("Apple", 0.2)),
        age_range=(22, 40),
        city_tier_weights=(("tier_1", 0.60), ("tier_2", 0.30), ("rural", 0.10)),
        gender_weights=(("Male", 0.55), ("Female", 0.43), ("Other", 0.02)),
        budget_min_npr=50_000,
        budget_max_npr=200_000,
        brand_loyalty_score=0.70,
        purchase_frequency_per_year=2.0,
        n_past_purchases=2,
        avg_session_minutes=20.0,
        search_freq_per_week=14,
        compare_freq_per_week=9,
        click_through_rate=0.38,
        recency_days=60,
        avg_rating_given=4.2,
        interaction_channel_weights=(
            ("Mobile App", 0.5), ("Daraz", 0.20), ("Website", 0.15),
            ("Instagram DM", 0.10), ("WhatsApp", 0.05),
        ),
        wishlist_conversion_rate=0.30,
        accessory_affinity=0.5,
    ),
}


# ---------------------------------------------------------------------------
# Weights for sampling — sum to 1.0.
# ---------------------------------------------------------------------------
ARCHETYPE_WEIGHTS: Dict[str, float] = {
    name: spec.weight for name, spec in ARCHETYPES.items()
}

assert abs(sum(ARCHETYPE_WEIGHTS.values()) - 1.0) < 1e-9, (
    "Archetype weights must sum to 1.0; got "
    f"{sum(ARCHETYPE_WEIGHTS.values()):.6f}"
)

ARCHETYPE_NAMES: List[str] = list(ARCHETYPES.keys())


# ---------------------------------------------------------------------------
# Per-archetype consistency invariants — used by validate.py.
# These are the rules the generator must obey:
#   - ArchetypeSpec.interests["gaming_interest"] is high  →  refresh_rate >= 120
#   - ArchetypeSpec.interests["battery_interest"] is high →  battery_mah >= 5000
#   - ArchetypeSpec.chipset_tier in {Flagship, Flagship-Killer} → RAM >= 8
#   - ...
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class InvariantRule:
    """A single internal-consistency rule (label → predicate string)."""
    name: str
    description: str
    # Columns the rule touches.
    columns: Tuple[str, ...]


INVARIANTS: List[InvariantRule] = [
    InvariantRule(
        name="gaming_implies_high_refresh",
        description="Gaming interest >= 80 → refresh_rate >= 120 Hz",
        columns=("gaming_interest", "min_refresh_rate_hz"),
    ),
    InvariantRule(
        name="battery_implies_big_cell",
        description="Battery interest >= 80 → battery_mah >= 5000",
        columns=("battery_interest", "min_battery_mah"),
    ),
    InvariantRule(
        name="flagship_implies_enough_ram",
        description="Chipset tier = Flagship → RAM >= 8 GB",
        columns=("chipset_tier", "min_ram_gb"),
    ),
    InvariantRule(
        name="photographer_implies_storage",
        description="Camera interest >= 85 → storage >= 128 GB",
        columns=("camera_interest", "min_storage_gb"),
    ),
    InvariantRule(
        name="display_implies_high_refresh",
        description="Display interest >= 80 → refresh_rate >= 120 Hz",
        columns=("display_interest", "min_refresh_rate_hz"),
    ),
]
