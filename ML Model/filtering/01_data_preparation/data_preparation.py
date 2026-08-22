"""Data preparation for collaborative filtering.

Refines:
  - ML Model/SegmentationTask/customer_segmentation_dataset.csv  (read-only)
  - dataset/GSMArena_cleaned_dataset.csv                          (read-only)

Produces in ML model/filtering/01_data_preparation/output/:
  - customer_profiles_clean.csv   (user profile, no model_name)
  - phone_catalog.csv             (filtered GSMArena catalog)
  - interactions.csv              (CF interaction log)
  - cold_start_holdout.csv        (cold-start subset spec)

This script is deterministic (fixed seed). It does NOT modify any input file.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SEG_CSV = PROJECT_ROOT / "ML Model" / "SegmentationTask" / "customer_segmentation_dataset.csv"
PHONES_CSV = PROJECT_ROOT / "dataset" / "GSMArena_Cleaned_Dataset.csv"

OUT_DIR = PROJECT_ROOT / "ML model" / "filtering" / "01_data_preparation" / "output"
OUT_DIR.mkdir(parents=True, exist_ok=True)

EUR_TO_NPR = 140
SEED = 42


# ---------------------------------------------------------------------------
# Nepal geography (mirrors the segmentation upstream, kept in sync by hand)
# ---------------------------------------------------------------------------
NEPAL_LOCATIONS: dict[str, dict[str, list[str]]] = {
    "Koshi Province": {
        "Bhojpur": ["Bhojpur", "Shadanand", "Tyamke Maiyum", "Arun", "Dingla", "Pouwadumma", "Hatuwagadhi"],
        "Dhankuta": ["Dhankuta", "Pakhribas", "Mahalaxmi", "Bhedetar", "Hile", "Sidhuwa", "Leguwa", "Mulghat"],
        "Ilam": ["Ilam", "Suryodaya", "Mai", "Deumai", "Pashupatinagar", "Fikkal", "Mangalbare", "Chulachuli"],
        "Jhapa": ["Birtamod", "Damak", "Mechinagar", "Bhadrapur", "Kankai", "Arjundhara", "Shivasatakshi", "Gauradaha", "Surunga", "Dhulabari", "Chandragadhi"],
        "Khotang": ["Diktel", "Halesi Tuwachung", "Aiselukharka", "Rawabesi", "Buipa", "Chisapani", "Halesi Bazar"],
        "Morang": ["Biratnagar", "Sundar Haraincha", "Belbari", "Pathari Sanischare", "Urlabari", "Rangeli", "Ratuwamai", "Sunawarshi", "Letang", "Katahari"],
        "Okhaldhunga": ["Siddhicharan", "Manebhanjyang", "Champadevi", "Molung", "Rumjatar", "Khiji Demba", "Ghorakhori"],
        "Panchthar": ["Phidim", "Yangwarak", "Kummayak", "Tumbewa", "Rabi", "Yasok", "Mauwa"],
        "Sankhuwasabha": ["Khandbari", "Chainpur", "Madi", "Dharmadevi", "Panchkhapan", "Tumlingtar", "Hedangna", "Num"],
        "Solukhumbu": ["Salleri", "Namche Bazaar", "Lukla", "Sotang", "Khumbu Pasanglhamu", "Necha Salyan", "Phaplu"],
        "Sunsari": ["Dharan", "Itahari", "Inaruwa", "Jhumka", "Duhabi", "Ramdhuni", "Barahachhetra", "Laukahi", "Bhartipur"],
        "Taplejung": ["Phungling", "Aathrai Tribeni", "Pathibhara Yangwarak", "Meringden", "Sinuwa", "Olangchung Gola", "Dobhan", "Suketar"],
        "Tehrathum": ["Myanglung", "Laligurans", "Aathrai", "Chhathar", "Basantapur", "Jirikhimti", "Sankranti Bazar"],
        "Udayapur": ["Gaighat", "Katari", "Chaudandigadhi", "Beltar", "Murkuchi", "Rampur Thoksila", "Hadiya", "Bhantar"],
    },
    "Madhesh Province": {
        "Bara": ["Kalaiya", "Jeetpur Simara", "Nijgadh", "Mahagadhimai", "Simraungadh", "Kolhabi", "Paiya", "Karaiyaia"],
        "Dhanusha": ["Janakpur Dham", "Mahendranagar", "Dhanushadham", "Mithila", "Sabaila", "Ganeshman Charnath", "Kshireshwornath", "Yadukuha", "Dhalkebar"],
        "Mahottari": ["Jaleshwar", "Bardibas", "Gaushala", "Loharpatti", "Ramgopalpur", "Manra Siswa", "Matihani", "Aurahi"],
        "Parsa": ["Birgunj", "Pokhariya", "Bahudarmai", "Parsagadhi", "Alau", "Dryport", "Prasuni", "Jeetpur"],
        "Rautahat": ["Gour", "Chandrapur", "Garuda", "Katariya", "Moulapur", "Gujara", "Ishnath", "Brindaban", "Rajpur"],
        "Saptari": ["Rajbiraj", "Kanakpatti", "Hanumannagar", "Khadak", "Shambhunath", "Bodebarsain", "Dakneshwari", "Rupani", "Kanchanpur"],
        "Sarlahi": ["Malangwa", "Hariyon", "Lalbandi", "Barahathawa", "Ishworpur", "Godaita", "Bagmati", "Kabilasi", "Nawalpur"],
        "Siraha": ["Lahan", "Siraha Bazar", "Golbazar", "Mirchaiya", "Sukhipur", "Dhangadhimai", "Kalyanpur", "Bishnupur", "Bandipur"],
    },
    "Bagmati Province": {
        "Bhaktapur": ["Bhaktapur", "Madhyapur Thimi", "Suryabinayak", "Changunarayan", "Nagarkot", "Sano Thimi", "Duwakot", "Lokanthali"],
        "Chitwan": ["Bharatpur", "Ratnanagar", "Khairahani", "Madi", "Rapti", "Kalika", "Mugling", "Sauraha", "Narayanagarh"],
        "Dhading": ["Nilkantha", "Galchhi", "Malekhu", "Dhading Besi", "Gajuri", "Benighat", "Salyantar", "Khanikhola"],
        "Dolakha": ["Charikot", "Jiri", "Baiteshwor", "Singati", "Bhimeshwor", "Sailung", "Mainapokhari", "Kirantichhap"],
        "Kathmandu": ["Kathmandu", "Kirtipur", "Budhanilkantha", "Tokha", "Sankharapur", "Kageshwari Manohara", "Tarakeshwar", "Chandragiri", "Nagarjun", "Balaju"],
        "Kavrepalanchok": ["Dhulikhel", "Banepa", "Panauti", "Paanchkhal", "Namobuddha", "Mandandeupur", "Khopasi", "Sangari", "Dolalghat"],
        "Lalitpur": ["Lalitpur", "Mahalaxmi", "Godawari", "Lubhu", "Bungamati", "Lele", "Imadol", "Dhapakhel"],
        "Makwanpur": ["Hetauda", "Thaha", "Manahari", "Bhimphedi", "Palung", "Daman", "Chhatiwan", "Baisa"],
        "Nuwakot": ["Bidur", "Battar", "Kakani", "Trisuli Bazar", "Belkotgadhi", "Devghat", "Ranipauwa", "Chhahare"],
        "Ramechhap": ["Manthali", "Ramechhap Bazar", "Khadadevi", "Likhu", "Doramba", "Khimti", "Suntale", "Sangutar"],
        "Rasuwa": ["Dhunche", "Syabrubesi", "Kalikasthan", "Timure", "Thuman", "Langtang", "Betrawati", "Ramche"],
        "Sindhuli": ["Kamalamai", "Dudhauli", "Khaniya Kharka", "Sindhulimadi", "Bhiman", "Khurkot", "Golanjor", "Nepalthok"],
        "Sindhupalchok": ["Chautara", "Melamchi", "Barhabise", "Tatopani", "Jalbire", "Sukute", "Sangachok", "Khudra"],
    },
    "Gandaki Province": {
        "Baglung": ["Baglung", "Galkot", "Jaimini", "Burtiwang", "Hatiya", "Kushmisera", "Bhimditap", "Kharbang"],
        "Gorkha": ["Gorkha Bazar", "Palungtar", "Arughat", "Barpak", "Abukhaireni", "Manakamana", "Chhepetar", "Saurpani"],
        "Kaski": ["Pokhara", "Lekhnath", "Ghandruk", "Hemja", "Gagangauda", "Batulechaur", "Sarangkot", "Naudanda"],
        "Lamjung": ["Besisahar", "Sundarbazar", "Rainas", "Madhya Nepal", "Bhoteodar", "Khudi", "Ghalegaun", "Kunchha"],
        "Manang": ["Chame", "Manang Village", "Pisang", "Tal", "Braga", "Khangsar", "Nar", "Phu"],
        "Mustang": ["Jomsom", "Kagbeni", "Muktinath", "Marpha", "Lo Manthang", "Lete", "Chhusang", "Tukuche"],
        "Myagdi": ["Beni", "Ghale Gaun", "Darwang", "Ghorepani", "Babiyachaur", "Singa", "Tatopani", "Pakhapani"],
        "Nawalpur": ["Kawasoti", "Gaindakot", "Devchuli", "Madhyabindu", "Arunkhola", "Dumkibas", "Danda", "Pragatinagar"],
        "Parbat": ["Kushma", "Phalebas", "Hubas", "Setibeni", "Karkineta", "Modibeni", "Wami", "Deupur"],
        "Syangja": ["Putalibazar", "Waling", "Galyang", "Chapakot", "Mirmi", "Bheirkot", "Bayarghat", "Fedikhola"],
        "Tanahun": ["Damauli", "Dulegauda", "Bhimad", "Bandipur", "Anbu Khaireni", "Khairenitar", "Kotre", "Dumre", "Thumpokhari"],
    },
    "Lumbini Province": {
        "Arghakhanchi": ["Sandhikharka", "Gorusinghe", "Sitganga", "Chhatradev", "Malrani", "Thada", "Khanchikot", "Argha"],
        "Banke": ["Nepalgunj", "Kohalpur", "Khajura", "Bayalpata", "Chisapani", "Ganapur", "Raniyapur", "Kamdi"],
        "Bardiya": ["Gulariya", "Rajapur", "Madhuwan", "Bansgadhi", "Thakurbawa", "Barbardiya", "Bhurigaun", "Magaragadi"],
        "Dang": ["Ghorahi", "Tulsipur", "Lamahi", "Bhalubang", "Gadhawa", "Manpur", "Narayanpur", "Hapur", "Koilabas"],
        "Eastern Rukum": ["Rukumkot", "Takasera", "Lukum", "Mahat", "Kol", "Ranma", "Kankri", "Hukam"],
        "Gulmi": ["Tamghas", "Ridi", "Resunga", "Wami Taksar", "Musikot", "Shantipur", "Baluwa", "Chhatrakot"],
        "Kapilvastu": ["Taulihawa", "Banganga", "Chandrauta", "Krishnanagar", "Buddhabhumi", "Maharajgunj", "Gorusanghe", "Pakadi"],
        "Palpa": ["Tansen", "Rampur", "Arghali", "Madanpokhara", "Harthok", "Aryabhanjyang", "Chhahara", "Baldengadhi"],
        "Parasi": ["Ramgram", "Sunwal", "Bardaghat", "Parasi Bazar", "Maheshpur", "Guthi Prasuni", "Panchanagar", "Bhawanipur"],
        "Pyuthan": ["Pyuthan Bazar", "Bijuwar", "Chernetes", "Khalanga", "Bargadgadhi", "Dakhaquadi", "Machchhi", "Wongma"],
        "Rolpa": ["Liwang", "Sulichaur", "Holeri", "Thabang", "Ghartigaun", "Nerpa", "Jedwang", "Khungri"],
        "Rupandehi": ["Butwal", "Bhairahawa", "Tilottama", "Lumbini", "Devdaha", "Siddharthanagar", "Manigram", "Sainamaina", "Kotahimai", "Mariya"],
    },
    "Karnali Province": {
        "Dailekh": ["Narayan", "Dullu", "Aathbis", "Chamunda", "Ramikot", "Tallo Dungeshwor", "Noubasta", "Jambu"],
        "Dolpa": ["Dunai", "Juphal", "Shey Phoksundo", "Tripurakot", "Kaigaon", "Saldang", "Dho Tarap", "Majhfal"],
        "Humla": ["Simikot", "Yari", "Muchu", "Sarkegad", "Darma", "Kermi", "Limatand", "Srinagar"],
        "Jajarkot": ["Khalanga", "Chhedagad", "Nalgad", "Barekot", "Dalli", "Kudu", "Pata", "Dashera"],
        "Jumla": ["Chandannath", "Tatopani", "Narakot", "Dillichaur", "Chautha", "Haku", "Garjyangkot", "Urthu Bazar"],
        "Kalikot": ["Manma", "Raska", "Tilagufa", "Pachaljharna", "Padamghat", "Khidkee", "Serighat", "Nagma"],
        "Mugu": ["Gamgadhi", "Rara", "Sorukot", "Talcha", "Pulu", "Srikot", "Dhainkot", "Khatyad"],
        "Salyan": ["Sharada", "Bagchaur", "Srinagar", "Luham", "Tharmare", "Kapurkot", "Kavra", "Bhalchaur"],
        "Surkhet": ["Birendranagar", "Chhinchu", "Gumwakot", "Mehelkuna", "Bhurigaun", "Babiyachaur", "Ramghat", "Dhari", "Malarani"],
        "Western Rukum": ["Musikot", "Chaurjahari", "Aathbiskot", "Sallaghari", "Solabangga", "Arma", "Rari", "Jhula"],
    },
    "Sudurpashchim Province": {
        "Achham": ["Mangalsen", "Sanfebagar", "Kamalbazar", "Jayagadh", "Bayanpata", "Kuchigaun", "Mellekh", "Dhakari"],
        "Baitadi": ["Dasharathchand", "Patan", "Melauli", "Jhulaaghat", "Gaurishankar", "Dehimandau", "Gokuleshwor", "Khodpe"],
        "Bajhang": ["Chainpur", "Talkot", "Khaptad", "Bungal", "Jhota", "Deura", "Tamail", "Rayal"],
        "Bajura": ["Martadi", "Kolti", "Tribeni", "Budhiganga", "Barhabise", "Dogadi", "Manakot", "Chatara"],
        "Dadeldhura": ["Amargadhi", "Jogbudha", "Parshuram", "Bagbazar", "Pokhara Bazar", "Ugratara", "Ganeshpur", "Belapur"],
        "Darchula": ["Khalanga", "Gokuleshwar", "Shailalya", "Marma", "Duhun", "Huti", "Rapla", "Jauljibi"],
        "Doti": ["Dipayal Silgadhi", "Boghistan", "Poti", "Jorayal", "Sanagau", "Budhar", "Kapalleki", "Rajpur"],
        "Kailali": ["Dhangadhi", "Tikapur", "Attariya", "Lamki", "Ghodaghodi", "Bhajani", "Sukhad", "Hasuliya", "Chisapani", "Phultala"],
        "Kanchanpur": ["Bhimdatta", "Mahendranagar", "Dodhara", "Chandani", "Bedkot", "Belauri", "Shuklaphanta", "Krishnapur", "Jhalari", "Punasan"],
    },
}


def _flatten_geo() -> tuple[set[str], set[str], set[str], dict[str, set[str]]]:
    provinces: set[str] = set()
    districts: set[str] = set()
    locations: set[str] = set()
    district_to_province: dict[str, set[str]] = defaultdict(set)
    location_to_district: dict[str, set[str]] = defaultdict(set)
    for prov, dist_map in NEPAL_LOCATIONS.items():
        provinces.add(prov)
        for dist, locs in dist_map.items():
            districts.add(dist)
            district_to_province[dist].add(prov)
            for loc in locs:
                locations.add(loc)
                location_to_district[loc].add(dist)
    return provinces, districts, locations, district_to_province


# ---------------------------------------------------------------------------
# Brand normalization
# ---------------------------------------------------------------------------
BRAND_ALIASES = {
    "Redmi": "Xiaomi",
    "Xiaomi": "Xiaomi",
    "Poco": "Xiaomi",
    "Samsung": "Samsung",
    "Apple": "Apple",
    "Oppo": "Oppo",
    "Vivo": "Vivo",
    "Realme": "Realme",
    "Oneplus": "Oneplus",
    "Google": "Google",
    "ASUS": "Asus",
    "Asus": "Asus",
    "Huawei": "Huawei",
    "Honor": "Honor",
    "Tecno": "Tecno",
    "Infinix": "Infinix",
    "Motorola": "Motorola",
    "Nokia": "Nokia",
}


def normalize_brand(brand: str | float) -> str:
    if not isinstance(brand, str):
        return ""
    return BRAND_ALIASES.get(brand.strip(), brand.strip())


def normalize_name(s: str) -> str:
    if not isinstance(s, str):
        return ""
    out = []
    for ch in s.lower():
        if ch.isalnum():
            out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------------------
# Determinism helpers
# ---------------------------------------------------------------------------
def hash_int(s, mod=10 ** 9) -> int:
    h = hashlib.md5(str(s).encode("utf-8")).hexdigest()
    return int(h[:12], 16) % mod


def hash_unit(s) -> float:
    return hash_int(s, 10 ** 6) / 10 ** 6


# ---------------------------------------------------------------------------
# 1. Schema inspection
# ---------------------------------------------------------------------------
def inspect_schemas(seg: pd.DataFrame, phones: pd.DataFrame) -> None:
    print("=" * 72)
    print("STEP 1 — Schema inspection")
    print("=" * 72)
    print(f"\n[customer_segmentation_dataset.csv]  rows={len(seg)}  cols={len(seg.columns)}")
    print(f"  columns: {seg.columns.tolist()}")
    print(f"  dtypes:")
    for c, dt in seg.dtypes.items():
        print(f"    {c}: {dt}")
    print(f"  nulls per column:")
    nulls = seg.isna().sum()
    for c, n in nulls.items():
        if n > 0:
            print(f"    {c}: {n}")

    print(f"\n[GSMArena_Cleaned_Dataset.csv]  rows={len(phones)}  cols={len(phones.columns)}")
    print(f"  columns: {phones.columns.tolist()}")
    print(f"  key spec NaN counts:")
    for c in [
        "Brand", "Model_Name", "Status", "5G_Support", "Announced_Year",
        "Price_EUR", "RAM_GB", "Storage_GB", "Refresh_Rate_Hz",
        "Battery_mAh", "Main_Camera_MP", "Chipset_Is_Flagship",
    ]:
        print(f"    {c}: {phones[c].isna().sum()}  (dtype={phones[c].dtype})")

    print(f"  Status.startswith('Available') phones: "
          f"{phones['Status'].astype(str).str.startswith('Available').sum()}")
    print(f"  5G_Yes phones: {(phones['5G_Support'] == 'Yes').sum()}")
    print(f"  Announced_Year >= 2020: {(phones['Announced_Year'] >= 2020).sum()}")
    print()


# ---------------------------------------------------------------------------
# 2. Phone catalog filter
# ---------------------------------------------------------------------------
def build_phone_catalog(phones: pd.DataFrame) -> pd.DataFrame:
    """Build a CF-suitable phone catalog.

    Keep phones that are 5G, currently/recently Available, Announced_Year >= 2020,
    have plausible specs, and priced in a band that a Nepal customer might buy.
    """
    df = phones.copy()
    df = df[
        df["Status"].astype(str).str.startswith("Available", na=False)
        & (df["5G_Support"] == "Yes")
        & (df["Announced_Year"] >= 2020)
        & (df["Price_EUR"].fillna(0) > 30)         # drop junk 0/very-low rows
        & (df["Price_EUR"].fillna(0) < 3000)       # cap at ~NPR 420k
        & (df["Battery_mAh"].fillna(0) >= 1500)    # junk batteries (0 / 33280)
        & (df["Battery_mAh"].fillna(0) <= 12000)
        & (df["Refresh_Rate_Hz"].fillna(60) >= 60)
        & (df["Refresh_Rate_Hz"].fillna(60) <= 240)
        & (df["RAM_GB"].fillna(0) >= 1)
    ].copy()

    df["npr_price"] = df["Price_EUR"].astype(float) * EUR_TO_NPR

    def to_tier(row):
        if row["npr_price"] >= 80000 or float(row.get("Chipset_Is_Flagship", 0)) == 1:
            return "Flagship"
        if row["npr_price"] >= 25000:
            return "Mid"
        return "Budget"

    df["tier"] = df.apply(to_tier, axis=1)
    df["Brand_norm"] = df["Brand"].astype(str).apply(normalize_brand)
    df["Model_Name_norm"] = df["Model_Name"].astype(str).apply(normalize_name)

    # Soft-preference scores used to rank candidate phones for a customer
    df["gaming_score"] = (
        df["RAM_GB"].fillna(0) * 2.0
        + df["Refresh_Rate_Hz"].fillna(60) / 30.0
        + df["Chipset_Is_Flagship"].fillna(0) * 8.0
    )
    df["camera_score"] = (
        df["Main_Camera_MP"].fillna(0) * 1.5 + df["Lens_Count"].fillna(0)
    )
    df["battery_score"] = df["Battery_mAh"].fillna(0) / 100.0
    df["display_score"] = df["Refresh_Rate_Hz"].fillna(60)
    df["performance_score"] = (
        df["Chipset_Is_Flagship"].fillna(0) * 10.0
        + df["RAM_GB"].fillna(0) * 0.8
        + df["AnTuTu_Score"].fillna(0) / 100000.0
    )
    df["software_score"] = (
        df["NFC"].apply(lambda x: 5 if x == "Yes" else 0)
        + df["Has_HDR"].fillna(0) * 2
        + df["Chipset_Is_Flagship"].fillna(0) * 3
    )
    # value_score: (battery/1000 + ram + storage/64) divided by price-tiers
    # use a vectorised approach (avoid Series ambiguous truthiness)
    price_factor = (df["npr_price"] / 30000.0).clip(lower=1.0)
    df["value_score"] = (
        df["Battery_mAh"].fillna(0) / 1000.0
        + df["RAM_GB"].fillna(0)
        + df["Storage_GB"].fillna(0) / 64.0
    ) / price_factor

    # Deduplicate on Model_Name — multiple GSMArena variants (regional
    # suffixes, etc.) collapse to one canonical entry.
    df = df.drop_duplicates(subset=["Model_Name"], keep="first").reset_index(drop=True)

    df = df.reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# 3. Spec-matching join: assign a real GSMArena phone to each customer
# ---------------------------------------------------------------------------
def assign_phone_for_customer(row, catalog: pd.DataFrame) -> str:
    """Pick the catalog phone that best matches this customer's specs/preferences.

    Two-stage:
      1. HARD FILTER — keep phones that satisfy the customer's hard requirements:
         - tier matches chipset_tier (or one tier up; never one tier down)
         - RAM_GB >= min_ram_gb
         - Storage_GB >= min_storage_gb
         - Refresh_Rate_Hz >= min_refresh_rate_hz
         - Battery_mAh >= min_battery_mah
         - npr_price is within +/-20% of the customer's budget band
         - 5G + Announced_Year >= 2020 (already guaranteed in catalog)
      2. SOFT SCORE — rank candidates by preference match. For each of the
         customer's 7 interest dimensions, multiply the catalog phone's score
         on that dimension by (interest / 100). Brand-loyal customers
         (brand_loyalty_score >= 0.7) get a brand-match bonus; a small
         budget-proximity bonus rewards phones close to the mid-budget.
      3. TIE-BREAK deterministically by hash so two runs are identical.
    """
    cid = row["customer_id"]

    bmin = float(row["budget_min_npr"])
    bmax = float(row["budget_max_npr"])
    bmid = (bmin + bmax) / 2.0

    min_ram = float(row["min_ram_gb"])
    min_sto = float(row["min_storage_gb"])
    min_rr = float(row["min_refresh_rate_hz"])
    min_bat = float(row["min_battery_mah"])
    tier = row["chipset_tier"]
    target_brand = normalize_brand(row.get("preferred_brand", ""))
    loyalty = float(row.get("brand_loyalty_score", 0.0))

    interests = {
        "gaming": float(row["gaming_interest"]),
        "camera": float(row["camera_interest"]),
        "battery": float(row["battery_interest"]),
        "display": float(row["display_interest"]),
        "performance": float(row["performance_interest"]),
        "software": float(row["software_interest"]),
        "value": float(row["value_interest"]),
    }

    # Stage 1 — hard filter
    cand = catalog
    cand = cand[cand["RAM_GB"] >= min_ram]
    cand = cand[cand["Storage_GB"] >= min_sto]
    cand = cand[cand["Refresh_Rate_Hz"] >= min_rr]
    cand = cand[cand["Battery_mAh"] >= min_bat]
    cand = cand[cand["npr_price"] >= bmin * 0.6]   # phone can be 40% cheaper than min
    cand = cand[cand["npr_price"] <= bmax * 1.2]   # or 20% over max

    # tier constraint: must satisfy tier or be one tier higher (allowing "mid+
    # flagship shopper accepts flagship")
    tier_rank = {"Budget": 0, "Mid": 1, "Flagship": 2}
    need = tier_rank.get(tier, 1)
    cand = cand[cand["tier"].map(tier_rank).fillna(1) >= max(0, need - 1)]

    if cand.empty:
        # Relax tier first
        cand = catalog[
            (catalog["RAM_GB"] >= min_ram)
            & (catalog["Storage_GB"] >= min_sto)
            & (catalog["npr_price"] >= bmin * 0.4)
            & (catalog["npr_price"] <= bmax * 1.5)
        ]
    if cand.empty:
        # Final fallback: any phone in budget range
        cand = catalog[
            (catalog["npr_price"] >= bmin * 0.4)
            & (catalog["npr_price"] <= bmax * 2.0)
        ]
    if cand.empty:
        # Absolute last resort: pick the cheapest in catalog
        return catalog.sort_values("npr_price").iloc[0]["Model_Name"]

    # Stage 2 — soft score
    score = np.zeros(len(cand), dtype=float)
    for dim, weight in interests.items():
        col = f"{dim}_score"
        if col in cand.columns:
            # Normalise catalog score to [0, 1] within candidate pool
            col_vals = cand[col].astype(float).values
            lo, hi = np.min(col_vals), np.max(col_vals)
            if hi > lo:
                norm = (col_vals - lo) / (hi - lo)
            else:
                norm = np.ones_like(col_vals)
            score += norm * (weight / 100.0)

    # Brand-match bonus (loyal customers strongly prefer their brand)
    if target_brand:
        brand_bonus = (cand["Brand_norm"] == target_brand).astype(float).values
        score += brand_bonus * (0.4 + 0.8 * loyalty)

    # Budget proximity: closer to mid-budget is better
    prices = cand["npr_price"].astype(float).values
    budget_span = max(1.0, bmax - bmin)
    proximity = 1.0 - np.clip(np.abs(prices - bmid) / budget_span, 0, 1)
    score += proximity * 0.15

    # Deterministic jitter — strong enough to break ties between similar phones
    # so we don't collapse 4500 customers onto one or two best-matched models.
    # The seed is per-(customer, candidate) so reruns are stable.
    jitter = np.array(
        [hash_unit(f"{cid}:{m}") for m in cand["Model_Name"].values]
    )
    score += jitter * 0.5  # ~50% relative spread breaks ties meaningfully

    # Soft price-tier rounding — phones slightly cheaper than budget midpoint
    # get a small bonus to push customers toward more popular phones.
    price_ratio = (prices - bmin) / max(1.0, bmax - bmin)
    score += np.clip(1 - np.abs(price_ratio - 0.6), 0, 1) * 0.05

    best_idx = int(np.argmax(score))
    return cand.iloc[best_idx]["Model_Name"]


# ---------------------------------------------------------------------------
# 4. Geography cleaning
# ---------------------------------------------------------------------------
def clean_geography(seg: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    provinces, districts, locations, dist2prov = _flatten_geo()

    out = seg.copy()
    fixes: dict[str, int] = Counter()

    for i, row in out.iterrows():
        prov = row.get("province")
        dist = row.get("district")
        loc = row.get("location")

        # Province
        if prov not in provinces:
            # try to find by fuzzy match against district
            if dist in districts and len(dist2prov[dist]) == 1:
                out.at[i, "province"] = list(dist2prov[dist])[0]
                fixes["province_from_district"] += 1
            else:
                # default to Bagmati (largest urban share)
                out.at[i, "province"] = "Bagmati Province"
                fixes["province_default"] += 1

        # District — must be valid for that province
        if dist not in districts:
            # fuzzy: location-based fallback
            if loc in locations:
                # any province that has both this district (none, so re-locate)
                out.at[i, "district"] = "Kathmandu"
                fixes["district_default_kathmandu"] += 1
            else:
                out.at[i, "district"] = "Kathmandu"
                fixes["district_default_kathmandu"] += 1
        else:
            prov_now = out.at[i, "province"]
            if prov_now in dist2prov.get(dist, {prov_now}) or dist not in dist2prov:
                pass
            elif prov_now not in dist2prov[dist]:
                # district exists but not in this province — fall back to a
                # province that does have this district
                out.at[i, "province"] = list(dist2prov[dist])[0]
                fixes["district_province_realigned"] += 1

        # Location — must be valid for that district
        d = out.at[i, "district"]
        valid_locs = NEPAL_LOCATIONS.get(out.at[i, "province"], {}).get(d, [])
        if loc not in valid_locs:
            # if location exists in some other district, keep it and change district
            if loc in locations:
                for d2, ls in NEPAL_LOCATIONS[out.at[i, "province"]].items():
                    if loc in ls:
                        out.at[i, "district"] = d2
                        fixes["location_district_realigned"] += 1
                        break
                else:
                    out.at[i, "location"] = valid_locs[0] if valid_locs else "Kathmandu"
                    fixes["location_default"] += 1
            else:
                out.at[i, "location"] = valid_locs[0] if valid_locs else "Kathmandu"
                fixes["location_default"] += 1

    # Re-validate every row
    final_ok = 0
    for i, row in out.iterrows():
        p, d, l = row["province"], row["district"], row["location"]
        if p in NEPAL_LOCATIONS and d in NEPAL_LOCATIONS.get(p, {}) and l in NEPAL_LOCATIONS[p][d]:
            final_ok += 1

    print(f"Geography: {final_ok}/{len(out)} rows pass hierarchy after cleaning.")
    print(f"  Fixes applied: {dict(fixes)}")
    return out, dict(fixes)


# ---------------------------------------------------------------------------
# 5. Interaction log generation
# ---------------------------------------------------------------------------
def generate_interactions(
    profiles: pd.DataFrame,
    catalog: pd.DataFrame,
    cold_start_customer_ids: set[str],
    cold_start_model_names: set[str],
    base_ts: pd.Timestamp,
) -> pd.DataFrame:
    """Generate a sparse interaction log.

    For each customer:
      - 0 or 1 'purchase' event (matching n_past_purchases - existing purchase).
        We treat the assigned model_name as their LAST purchase.
      - A handful of 'view' / 'search' / 'compare' events distributed across
        phones in their tier (and a few in adjacent tiers).
      - 'wishlist' events with probability = wishlist_conversion_rate.
      - 0 or 1 'rate' event on the purchased phone, value = avg_rating_given
        +/- noise.

    Noise injection:
      - Persona does NOT deterministically pick the phones interacted with.
      - A pool of candidate phones in budget tier is shuffled, then a
        deterministic subset is sampled. This means two customers with the
        same profile get different event lists.

    Cold-start handling:
      - Users in cold_start_customer_ids have ZERO interactions in this log
        (they are saved separately for cold-start evaluation).
      - Phones in cold_start_model_names may still receive interactions from
        non-cold-start users, but we mark them so the cold-start phone split
        is straightforward.

    Sparsity target: ~95-99% empty user-item pairs.
    """
    rng_global = np.random.default_rng(SEED)

    # Pre-index catalog by tier for fast sampling
    tier_to_phones = {
        t: catalog[catalog["tier"] == t][["Model_Name", "npr_price", "Brand_norm"]].values.tolist()
        for t in ("Budget", "Mid", "Flagship")
    }

    # Define the END timestamp for interactions (~ last 12 months from base_ts)
    # base_ts is set to "today" by caller.
    horizon_days = 365

    rows = []
    skipped_cold_users = 0

    for _, cust in profiles.iterrows():
        cid = cust["customer_id"]
        if cid in cold_start_customer_ids:
            skipped_cold_users += 1
            continue

        tier = cust["chipset_tier"]
        bmin = float(cust["budget_min_npr"])
        bmax = float(cust["budget_max_npr"])
        bmid = (bmin + bmax) / 2.0

        # Build candidate pool for this customer: phones in same tier,
        # price within +/-30% of budget band.
        own_tier = tier_to_phones.get(tier, [])
        cand_pool = [
            (m, p, b) for (m, p, b) in own_tier
            if p >= bmin * 0.7 and p <= bmax * 1.3
        ]
        # Add some "adjacent" candidates
        adj = tier_to_phones.get(
            "Flagship" if tier == "Mid" else "Mid", []
        )
        cand_pool += [
            (m, p, b) for (m, p, b) in adj
            if p >= bmin * 0.7 and p <= bmax * 1.3
        ]
        # Fallback if empty
        if not cand_pool:
            cand_pool = own_tier[:50] if own_tier else [
                list(x) for x in catalog[["Model_Name", "npr_price", "Brand_norm"]]
                .head(50).values
            ]
            cand_pool = [(m, p, b) for m, p, b in cand_pool]

        # Deterministic per-customer permutation of the candidate pool
        seed = hash_int(f"inter:{cid}")
        rnd = np.random.default_rng(seed)
        order = np.arange(len(cand_pool))
        rnd.shuffle(order)
        cand_pool = [cand_pool[i] for i in order]

        assigned_model = cust["model_name"]

        # --- 1 purchase event for their assigned phone ---
        n_past = max(1, int(cust["n_past_purchases"]))
        # First the existing one — purchase their assigned phone within last 12 months
        purchase_age_days = int(rnd.integers(0, min(365, max(30, cust["recency_days"] + 60))))
        ts_purchase = base_ts - pd.Timedelta(days=purchase_age_days)
        rating = float(np.clip(
            float(cust["avg_rating_given"]) + rnd.normal(0, 0.5), 1, 5
        ))
        rows.append({
            "customer_id": cid,
            "model_name": assigned_model,
            "interaction_type": "purchase",
            "rating": round(rating, 2),
            "timestamp": ts_purchase.isoformat(),
        })

        # --- Optional 'rate' event for the same phone, slightly later ---
        if rnd.random() < 0.6:
            ts_rate = ts_purchase + pd.Timedelta(days=int(rnd.integers(1, 30)))
            if ts_rate <= base_ts:
                rows.append({
                    "customer_id": cid,
                    "model_name": assigned_model,
                    "interaction_type": "rate",
                    "rating": rating,
                    "timestamp": ts_rate.isoformat(),
                })

        # --- View / search / compare events on other phones ---
        search_freq = int(cust["search_freq_per_week"])
        compare_freq = int(cust["compare_freq_per_week"])
        # Total non-purchase events scaled to a realistic number (clamped)
        n_explore = int(np.clip(search_freq + compare_freq + rnd.integers(2, 8), 3, 40))
        n_wishlist = int(np.clip(round(cust["wishlist_conversion_rate"] * n_explore * 0.6),
                                 0, max(0, n_explore // 3)))

        # Sample phones from cand_pool (skip the assigned one, but include as a
        # possible re-view)
        non_assigned = [(m, p, b) for (m, p, b) in cand_pool if m != assigned_model]
        if not non_assigned:
            non_assigned = cand_pool

        # Pick up to n_explore phones (with replacement)
        explore_choices: list[tuple[str, int]] = []
        for _ in range(n_explore):
            idx = int(rnd.integers(0, len(non_assigned)))
            explore_choices.append((non_assigned[idx][0], idx))

        # Assign interaction types in proportion: view > search > compare > wishlist
        types_pool = (
            ["view"] * 6
            + ["search"] * 3
            + ["compare"] * 2
            + ["wishlist"] * 1
        )
        # Timestamps spread across the year
        for i, (model, _) in enumerate(explore_choices):
            itype = types_pool[int(rng_global.integers(0, len(types_pool)))]
            day_offset = int(rnd.integers(0, horizon_days))
            ts = base_ts - pd.Timedelta(days=day_offset)
            # Rating only meaningful for purchase/rate
            r = rating if itype in ("purchase", "rate") else np.nan
            rows.append({
                "customer_id": cid,
                "model_name": model,
                "interaction_type": itype,
                "rating": r if pd.notna(r) else "",
                "timestamp": ts.isoformat(),
            })

        # --- Wishlist events (small subset) ---
        wishlist_targets = explore_choices[:n_wishlist] if n_wishlist else []
        for model, _ in wishlist_targets:
            day_offset = int(rnd.integers(0, horizon_days))
            ts = base_ts - pd.Timedelta(days=day_offset)
            rows.append({
                "customer_id": cid,
                "model_name": model,
                "interaction_type": "wishlist",
                "rating": "",
                "timestamp": ts.isoformat(),
            })

    interactions = pd.DataFrame(rows, columns=[
        "customer_id", "model_name", "interaction_type", "rating", "timestamp",
    ])

    # Sort by timestamp desc
    interactions["timestamp"] = pd.to_datetime(interactions["timestamp"])
    interactions = interactions.sort_values("timestamp", ascending=False).reset_index(drop=True)
    print(f"Interactions generated: {len(interactions)} rows "
          f"(skipped {skipped_cold_users} cold-start users).")
    return interactions


# ---------------------------------------------------------------------------
# Cold-start split + sparsity check
# ---------------------------------------------------------------------------
def make_cold_start_split(profiles: pd.DataFrame, catalog: pd.DataFrame):
    """Pick 5% of customers as cold-start users, 3% of phones as cold-start phones."""
    rng = np.random.default_rng(SEED + 1)
    n_cust_cold = max(50, int(round(len(profiles) * 0.05)))
    n_phone_cold = max(30, int(round(len(catalog) * 0.03)))

    cust_idx = rng.choice(len(profiles), size=n_cust_cold, replace=False)
    phone_idx = rng.choice(len(catalog), size=n_phone_cold, replace=False)

    cold_customers = set(profiles.iloc[cust_idx]["customer_id"].tolist())
    cold_phones = set(catalog.iloc[phone_idx]["Model_Name"].tolist())
    return cold_customers, cold_phones


def compute_sparsity(interactions: pd.DataFrame, profiles: pd.DataFrame, catalog: pd.DataFrame) -> float:
    n_users = profiles["customer_id"].nunique()
    n_items = catalog["Model_Name"].nunique()
    n_interactions = len(interactions)
    total = n_users * n_items
    if total == 0:
        return 0.0
    observed_pairs = interactions[["customer_id", "model_name"]].drop_duplicates().shape[0]
    sparsity = 1.0 - observed_pairs / total
    return sparsity


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    np.random.seed(SEED)
    random.seed(SEED)

    print("Loading inputs...")
    seg = pd.read_csv(SEG_CSV)
    phones = pd.read_csv(PHONES_CSV)
    print(f"  seg rows: {len(seg)}")
    print(f"  phones rows: {len(phones)}")

    inspect_schemas(seg, phones)

    # ---- Build catalog ----
    print("=" * 72)
    print("STEP 2 — Building phone catalog")
    print("=" * 72)
    catalog = build_phone_catalog(phones)
    print(f"  Catalog rows after filter: {len(catalog)}")
    print(f"  Tier distribution:\n{catalog['tier'].value_counts().to_string()}")
    print(f"  Top brands:\n{catalog['Brand_norm'].value_counts().head(10).to_string()}")

    # ---- Clean geography ----
    print("\n" + "=" * 72)
    print("STEP 3 — Cleaning geography")
    print("=" * 72)
    seg_clean, geo_fixes = clean_geography(seg)

    # ---- Re-assign model_name via spec-matching ----
    print("\n" + "=" * 72)
    print("STEP 4 — Re-assigning model_name via spec-matching join")
    print("=" * 72)
    new_models = []
    fallback_count = 0
    for _, row in seg_clean.iterrows():
        m = assign_phone_for_customer(row, catalog)
        if m == catalog.sort_values("npr_price").iloc[0]["Model_Name"]:
            fallback_count += 1
        new_models.append(m)
    seg_clean = seg_clean.copy()
    seg_clean["model_name"] = new_models
    print(f"  Assigned phones: {seg_clean['model_name'].nunique()} unique")
    print(f"  Rows where assigned phone is the absolute fallback (cheapest): {fallback_count}")

    # Cross-check: every assigned model exists in catalog
    in_catalog = seg_clean["model_name"].isin(catalog["Model_Name"]).sum()
    print(f"  Assigned phones in catalog: {in_catalog}/{len(seg_clean)}")

    # ---- Cold-start split ----
    print("\n" + "=" * 72)
    print("STEP 5 — Cold-start split")
    print("=" * 72)
    cold_customers, cold_phones = make_cold_start_split(seg_clean, catalog)
    print(f"  Cold-start customers: {len(cold_customers)}")
    print(f"  Cold-start phones: {len(cold_phones)}")

    # ---- Interaction log ----
    print("\n" + "=" * 72)
    print("STEP 6 — Generating interactions")
    print("=" * 72)
    base_ts = pd.Timestamp("2026-08-10")  # use today's date so timestamps are realistic
    interactions = generate_interactions(
        seg_clean, catalog, cold_customers, cold_phones, base_ts
    )

    sparsity = compute_sparsity(interactions, seg_clean, catalog)
    print(f"  User-item pair sparsity: {sparsity * 100:.2f}%")

    # ---- Write outputs ----
    print("\n" + "=" * 72)
    print("STEP 7 — Writing outputs")
    print("=" * 72)

    # 1. Customer profiles (no model_name)
    profile_cols = [c for c in seg_clean.columns if c != "model_name"]
    profiles_out = seg_clean[profile_cols].copy()
    profiles_out.to_csv(OUT_DIR / "customer_profiles_clean.csv", index=False)
    print(f"  wrote {OUT_DIR / 'customer_profiles_clean.csv'} ({len(profiles_out)} rows)")

    # 2. Phone catalog (filter to phones actually referenced in interactions or
    #    profiles, plus all cold-start candidates)
    used_models = set(interactions["model_name"].dropna().tolist()) | set(seg_clean["model_name"].tolist())
    catalog_used = catalog[catalog["Model_Name"].isin(used_models | cold_phones)].copy()
    catalog_out_cols = [
        "Model_Name", "Brand", "Brand_norm", "tier", "npr_price", "Price_EUR",
        "Announced_Year", "5G_Support", "Chipset", "Chipset_Is_Flagship",
        "Chipset_Brand", "Chipset_Family",
        "RAM_GB", "RAM_Max_GB", "Storage_GB", "Storage_Max_GB",
        "Refresh_Rate_Hz", "Display_Size_inch", "Display_Type",
        "Battery_mAh", "Wired_Charging_W",
        "Main_Camera_MP", "Selfie_Camera_MP", "Lens_Count", "OIS",
        "AnTuTu_Score", "GeekBench_Score",
        "OS", "NFC", "Colors",
    ]
    catalog_out_cols = [c for c in catalog_out_cols if c in catalog_used.columns]
    catalog_out = catalog_used[catalog_out_cols].reset_index(drop=True)
    catalog_out["is_cold_start_phone"] = catalog_out["Model_Name"].isin(cold_phones).astype(int)
    catalog_out.to_csv(OUT_DIR / "phone_catalog.csv", index=False)
    print(f"  wrote {OUT_DIR / 'phone_catalog.csv'} ({len(catalog_out)} rows)")

    # 3. Interactions
    interactions.to_csv(OUT_DIR / "interactions.csv", index=False)
    print(f"  wrote {OUT_DIR / 'interactions.csv'} ({len(interactions)} rows)")

    # 4. Cold-start holdout
    cold_profiles = seg_clean[seg_clean["customer_id"].isin(cold_customers)].copy()
    holdout_rows = []
    for _, row in cold_profiles.iterrows():
        holdout_rows.append({
            "holdout_kind": "cold_user",
            "customer_id": row["customer_id"],
            "model_name": "",
            "notes": "user held out from training interactions (zero history)",
        })
    for m in cold_phones:
        holdout_rows.append({
            "holdout_kind": "cold_phone",
            "customer_id": "",
            "model_name": m,
            "notes": "phone held out from training interactions",
        })
    holdout = pd.DataFrame(holdout_rows)
    holdout.to_csv(OUT_DIR / "cold_start_holdout.csv", index=False)
    print(f"  wrote {OUT_DIR / 'cold_start_holdout.csv'} ({len(holdout)} rows)")

    # ---- Final summary ----
    print("\n" + "=" * 72)
    print("FINAL SUMMARY")
    print("=" * 72)
    print(f"  customer_profiles_clean.csv : {len(profiles_out)} rows, {len(profiles_out.columns)} cols")
    print(f"  phone_catalog.csv           : {len(catalog_out)} rows, {len(catalog_out.columns)} cols")
    print(f"  interactions.csv            : {len(interactions)} rows, {len(interactions.columns)} cols")
    print(f"  cold_start_holdout.csv      : {len(holdout)} rows ({len(cold_customers)} cold users + "
          f"{len(cold_phones)} cold phones)")
    print(f"  Sparsity                    : {sparsity * 100:.2f}%")
    print(f"  Geography fixes             : {geo_fixes}")
    print("\nDone.")


if __name__ == "__main__":
    main()
