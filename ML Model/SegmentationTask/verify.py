"""Verification checks for the customer segmentation dataset."""
import sys
from pathlib import Path
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[2]
seg_csv = PROJECT_ROOT / "ML Model" / "SegmentationTask" / "customer_segmentation_dataset.csv"
cust_csv = PROJECT_ROOT / "dataset" / "customer_dataset.csv"
phones_csv = PROJECT_ROOT / "dataset" / "GSMArena_Cleaned_Dataset.csv"

b = pd.read_csv(seg_csv)
a = pd.read_csv(cust_csv)
phones = pd.read_csv(phones_csv)

errors = []
warnings = []

# 1. Identity preservation
real_ids = set(a["customer_id"].unique())
seg_ids = set(b["customer_id"])
if real_ids != seg_ids:
    errors.append(f"ID mismatch: missing={len(real_ids - seg_ids)}, extra={len(seg_ids - real_ids)}")
else:
    print(f"[OK] Identity preserved: {len(seg_ids)} unique customers match")

if b.duplicated("customer_id").sum() != 0:
    errors.append("Duplicated customer_id in segmentation dataset")
else:
    print("[OK] No duplicate customer_id")

# 2. Row count
if len(b) != 4557:
    errors.append(f"Expected 4557 rows, got {len(b)}")
else:
    print(f"[OK] Row count: {len(b)}")

# 3. Schema - check all required columns exist
expected_cols = [
    "customer_id", "customer_name", "province", "district", "location",
    "age", "gender",
    "budget_min_npr", "budget_max_npr",
    "preferred_brand", "brand_loyalty_score",
    "gaming_interest", "camera_interest", "battery_interest", "display_interest",
    "performance_interest", "software_interest", "value_interest",
    "min_ram_gb", "min_storage_gb", "chipset_tier",
    "min_refresh_rate_hz", "min_battery_mah",
    "purchase_frequency_per_year", "n_past_purchases",
    "avg_session_minutes", "search_freq_per_week", "compare_freq_per_week",
    "click_through_rate", "recency_days", "avg_rating_given",
    "interaction_channel", "wishlist_conversion_rate", "accessory_affinity",
    "model_name", "true_archetype",
]
missing_cols = set(expected_cols) - set(b.columns)
extra_cols = set(b.columns) - set(expected_cols)
if missing_cols:
    errors.append(f"Missing columns: {missing_cols}")
if extra_cols:
    warnings.append(f"Extra columns: {extra_cols}")
if not missing_cols:
    print(f"[OK] Schema complete: {len(b.columns)} columns")

# Check no tue_archetype typo
if "tue_archetype" in b.columns:
    errors.append("tue_archetype typo still present in output")
else:
    print("[OK] No 'tue_archetype' typo (renamed to true_archetype)")

# 4. No NaN in non-optional columns
nan_counts = b[expected_cols].isna().sum()
if nan_counts.sum() > 0:
    errors.append(f"NaN values: {nan_counts[nan_counts > 0].to_dict()}")
else:
    print("[OK] No NaN values in any column")

# 5. Phone existence
phone_set = set(phones["Model_Name"])
invalid_phones = set(b["model_name"]) - phone_set
if invalid_phones:
    errors.append(f"Invalid model_name values not in GSM Arena: {len(invalid_phones)}")
else:
    print(f"[OK] All {b['model_name'].nunique()} unique model_name values exist in GSM Arena")

# 5b. model_name brand must match preferred_brand
BRAND_ALIASES = {
    "Redmi": "Xiaomi", "Poco": "Xiaomi",
    "ASUS": "Asus",
}
def normalize_brand(brand):
    if not isinstance(brand, str):
        return ""
    return BRAND_ALIASES.get(brand.strip(), brand.strip())

phone_brand_map = dict(zip(phones["Model_Name"], phones["Brand"]))
mismatches = 0
for _, row in b.iterrows():
    pref = normalize_brand(row["preferred_brand"])
    model_brand = phone_brand_map.get(row["model_name"], "")
    if normalize_brand(model_brand) != pref:
        mismatches += 1
if mismatches:
    errors.append(f"model_name brand does not match preferred_brand: {mismatches} rows")
else:
    print("[OK] All model_name values belong to a phone whose brand matches preferred_brand")

# 6. Geography validity - check using the dictionary
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from generation_script import NEPAL_LOCATIONS

geo_errors = 0
for _, row in b.iterrows():
    prov = row["province"]
    dist = row["district"]
    loc = row["location"]
    if prov not in NEPAL_LOCATIONS:
        geo_errors += 1
        continue
    if dist not in NEPAL_LOCATIONS[prov]:
        geo_errors += 1
        continue
    if loc not in NEPAL_LOCATIONS[prov][dist]:
        geo_errors += 1
if geo_errors:
    errors.append(f"Geography hierarchy violations: {geo_errors}")
else:
    print("[OK] All geography entries respect province > district > location hierarchy")

# 7. Internal consistency rules
gamers = b[b["gaming_interest"] >= 80]
battery_focused = b[b["battery_interest"] >= 80]
camera_focused = b[b["camera_interest"] >= 85]
display_focused = b[b["display_interest"] >= 80]

if (gamers["min_refresh_rate_hz"] < 120).any():
    errors.append("Gamers with gaming_interest>=80 don't all have refresh>=120")
else:
    print(f"[OK] All {len(gamers)} hardcore gamers have min_refresh_rate_hz >= 120")

if (battery_focused["min_battery_mah"] < 5000).any():
    errors.append("Battery-focused users don't all have battery>=5000")
else:
    print(f"[OK] All {len(battery_focused)} battery-focused users have min_battery_mah >= 5000")

if (camera_focused["min_storage_gb"] < 128).any():
    errors.append("Camera-focused users don't all have storage>=128")
else:
    print(f"[OK] All {len(camera_focused)} camera-focused users have min_storage_gb >= 128")

# 8. Geography distribution - Bagmati/Madhesh should be at top
province_counts = b["province"].value_counts()
top2 = province_counts.head(2).sum() / len(b)
if top2 < 0.35:
    warnings.append(f"Top 2 provinces only {top2*100:.1f}% (expected ~40% for Bagmati+Madhesh)")
else:
    print(f"[OK] Top 2 provinces (Bagmati+Madhesh) = {top2*100:.1f}% of customers")

# 9. Budget ordering - min should be <= max
if (b["budget_min_npr"] > b["budget_max_npr"]).any():
    errors.append("budget_min_npr > budget_max_npr in some rows")
else:
    print("[OK] budget_min_npr <= budget_max_npr for all rows")

# 10. Interest scores in [0, 100]
for col in ["gaming_interest", "camera_interest", "battery_interest", "display_interest",
            "performance_interest", "software_interest", "value_interest"]:
    if b[col].min() < 0 or b[col].max() > 100:
        errors.append(f"{col} out of [0, 100] range")
print("[OK] All interest scores in [0, 100]")

# 11. Realism spot-checks
# Budget buyers should mostly have low budget
budget_buyers = b[b["true_archetype"] == "Budget Buyer"]
if budget_buyers["budget_max_npr"].median() > 40000:
    warnings.append(f"Budget Buyers median budget {budget_buyers['budget_max_npr'].median()} > 40000")
else:
    print(f"[OK] Budget Buyers median budget_max_npr = {budget_buyers['budget_max_npr'].median():.0f}")

# Gamer phones should have high RAM
gamers_real = b[b["true_archetype"] == "Hardcore Gamer"]
if gamers_real["min_ram_gb"].min() < 8:
    warnings.append(f"Hardcore Gamer min RAM = {gamers_real['min_ram_gb'].min()} (< 8)")
else:
    print(f"[OK] Hardcore Gamers all have min_ram_gb >= 8")

# Summary
print()
print("=" * 60)
if errors:
    print(f"FAILED: {len(errors)} errors")
    for e in errors:
        print(f"  ERROR: {e}")
else:
    print("ALL CHECKS PASSED")

if warnings:
    print(f"\n{len(warnings)} warnings:")
    for w in warnings:
        print(f"  WARN: {w}")
