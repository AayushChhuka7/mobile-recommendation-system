"""Generate the customer segmentation dataset.

Reads three input files (kept untouched):
  - dataset/customer_dataset.csv
  - ML Model/synthetic_outputs/synthetic_customers.csv
  - dataset/GSMArena_Cleaned_Dataset.csv

Writes:
  - ML Model/SegmentationTask/customer_segmentation_dataset.csv
  - ML Model/SegmentationTask/dataset_summary.md

The script is deterministic: same input -> same output.
"""

import hashlib
import math
import random
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = PROJECT_ROOT / "ML Model" / "SegmentationTask"
OUT_DIR.mkdir(parents=True, exist_ok=True)

CUSTOMER_CSV = PROJECT_ROOT / "dataset" / "customer_dataset.csv"
SYNTHETIC_CSV = PROJECT_ROOT / "ML Model" / "synthetic_outputs" / "synthetic_customers.csv"
PHONES_CSV = PROJECT_ROOT / "dataset" / "GSMArena_Cleaned_Dataset.csv"

EUR_TO_NPR = 140
SEED = 42


NEPAL_LOCATIONS = {
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


PROVINCE_WEIGHTS = {
    "Bagmati Province": 0.21,
    "Madhesh Province": 0.20,
    "Lumbini Province": 0.17,
    "Koshi Province": 0.17,
    "Gandaki Province": 0.10,
    "Sudurpashchim Province": 0.09,
    "Karnali Province": 0.06,
}

URBAN_DISTRICTS = {
    "Kathmandu", "Lalitpur", "Bhaktapur", "Morang", "Jhapa", "Rupandehi", "Kailali",
    "Chitwan", "Kaski", "Banke", "Parsa", "Dhanusha", "Kavrepalanchok", "Sunsari",
}

URBAN_LOCATIONS = {
    "Kathmandu", "Lalitpur", "Bhaktapur", "Biratnagar", "Pokhara", "Butwal",
    "Bhairahawa", "Bharatpur", "Birtamod", "Damak", "Dharan", "Itahari",
    "Nepalgunj", "Janakpur Dham", "Birgunj", "Dhangadhi", "Hetauda",
    "Ghorahi", "Tulsipur", "Tansen", "Lahan", "Rajbiraj", "Inaruwa",
    "Mahendranagar", "Bhimdatta", "Siddharthanagar", "Gulariya", "Beni",
    "Baglung", "Putalibazar", "Sandhikharka", "Tamghas", "Dasharathchand",
    "Amargadhi", "Mangalsen", "Chainpur", "Diktel", "Phidim", "Ilam",
    "Khandbari", "Manthali", "Charikot", "Jiri", "Bidur", "Dhankuta",
    "Myanglung", "Gaighat", "Phungling", "Bhojpur", "Salleri",
    "Gamgadhi", "Simikot", "Khalanga", "Chandannath", "Manma", "Dunai",
    "Martadi", "Dipayal Silgadhi", "Damauli", "Bandipur", "Palungtar",
    "Gorkha Bazar", "Besisahar", "Jomsom", "Chame", "Pyuthan Bazar",
    "Liwang", "Musikot", "Sharada", "Birendranagar", "Narayan", "Taulihawa",
    "Jaleshwar", "Malangwa", "Kalaiya", "Bardibas", "Gaur", "Gorkha",
    "Kawasoti", "Kushma", "Kirtipur", "Madhyapur Thimi", "Suryabinayak",
    "Kohalpur", "Tikapur", "Attariya", "Dhunche",
}

CHANNELS = [
    "Mobile App", "Website", "Daraz", "In-store", "WhatsApp",
    "Instagram DM", "Facebook Page", "Email", "Phone Call", "SastoDeal",
]
CHANNEL_WEIGHTS = [0.30, 0.16, 0.12, 0.10, 0.10, 0.07, 0.06, 0.04, 0.03, 0.02]

BRANDS = [
    "Samsung", "Apple", "Xiaomi", "Redmi", "Oppo", "Vivo", "Realme",
    "Oneplus", "Google", "ASUS", "Huawei", "Honor", "Tecno", "Infinix",
    "Motorola", "Nokia",
]
BRAND_WEIGHTS = [
    0.225, 0.12, 0.13, 0.07, 0.105, 0.095, 0.062, 0.033, 0.04, 0.04,
    0.039, 0.034, 0.023, 0.019, 0.027, 0.024,
]

ARCHETYPES = [
    "Hardcore Gamer",
    "Mobile Photographer",
    "Battery-Focused User",
    "Display Enthusiast",
    "Premium Flagship User",
    "Brand-Loyal Customer",
    "Budget Buyer",
    "All-Round User",
]


def hash_int(s, mod=10 ** 9):
    h = hashlib.md5(str(s).encode("utf-8")).hexdigest()
    return int(h[:12], 16) % mod


def hash_unit(s):
    return hash_int(s, 10 ** 6) / 10 ** 6


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def weighted_pick(rng, items, weights):
    total = sum(weights)
    pick = rng * total
    acc = 0.0
    for item, w in zip(items, weights):
        acc += w
        if pick <= acc:
            return item
    return items[-1]


def normalize_name(s):
    if not isinstance(s, str):
        return ""
    s = s.lower().strip()
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
    return "".join(out)


def category_to_interests(category):
    nudges = {
        "Battery-focused": {"battery_interest": 30, "value_interest": 10},
        "Gaming": {"gaming_interest": 35, "performance_interest": 25, "display_interest": 15},
        "Camera-centric": {"camera_interest": 35, "software_interest": 10},
        "Flagship": {"performance_interest": 25, "software_interest": 15, "display_interest": 10},
        "Premium Mid-range": {"software_interest": 15, "performance_interest": 15, "display_interest": 10},
        "Mid-range": {"software_interest": 5, "value_interest": 10},
        "5G Phones": {"display_interest": 15, "performance_interest": 10},
        "Foldable": {"display_interest": 20, "software_interest": 10, "value_interest": -10},
        "Compact Phones": {"value_interest": 15, "battery_interest": 10, "performance_interest": -5},
        "Rugged": {"battery_interest": 20, "value_interest": 10, "display_interest": -5},
        "Budget": {"value_interest": 25, "battery_interest": 10},
    }
    return nudges.get(category, {})


def brand_to_interests(brand):
    nudges = {
        "Apple": {"software_interest": 12, "camera_interest": 8},
        "Samsung": {"display_interest": 6, "software_interest": 5},
        "Google": {"camera_interest": 10, "software_interest": 8},
        "ASUS": {"gaming_interest": 15, "performance_interest": 10},
        "Oneplus": {"performance_interest": 8, "software_interest": 5},
        "Xiaomi": {"value_interest": 6, "battery_interest": 4},
        "Redmi": {"value_interest": 10, "battery_interest": 5},
        "Realme": {"value_interest": 8, "battery_interest": 4},
        "Oppo": {"camera_interest": 5, "software_interest": 3},
        "Vivo": {"camera_interest": 6, "display_interest": 3},
        "Huawei": {"camera_interest": 5, "battery_interest": 4},
        "Honor": {"value_interest": 4},
        "Motorola": {"battery_interest": 3, "value_interest": 3},
        "Tecno": {"battery_interest": 4, "value_interest": 4},
        "Infinix": {"value_interest": 5, "battery_interest": 4},
        "Nokia": {"battery_interest": 5, "value_interest": 3},
    }
    return nudges.get(brand, {})


def choose_archetype(interests):
    if interests["gaming_interest"] >= 80:
        return "Hardcore Gamer"
    if interests["camera_interest"] >= 85:
        return "Mobile Photographer"
    if interests["battery_interest"] >= 80:
        return "Battery-Focused User"
    if interests["display_interest"] >= 80:
        return "Display Enthusiast"
    if interests["performance_interest"] >= 75 and interests["budget_max_npr"] >= 100000:
        return "Premium Flagship User"
    if interests["brand_loyalty_score"] >= 0.7:
        return "Brand-Loyal Customer"
    if interests["budget_max_npr"] <= 35000:
        return "Budget Buyer"
    return "All-Round User"


def apply_internal_consistency(d):
    if d["gaming_interest"] >= 80:
        d["min_refresh_rate_hz"] = max(d["min_refresh_rate_hz"], 120)
        d["chipset_tier"] = "Flagship"
        d["min_ram_gb"] = max(d["min_ram_gb"], 8)
        d["min_storage_gb"] = max(d["min_storage_gb"], 128)
    if d["battery_interest"] >= 80:
        d["min_battery_mah"] = max(d["min_battery_mah"], 5000)
    if d["camera_interest"] >= 85:
        d["min_storage_gb"] = max(d["min_storage_gb"], 128)
    if d["display_interest"] >= 80:
        d["min_refresh_rate_hz"] = max(d["min_refresh_rate_hz"], 120)
    return d


def load_phones():
    df = pd.read_csv(PHONES_CSV)
    mask = (
        df["Status"].astype(str).str.startswith("Available", na=False)
        & (df["5G_Support"] == "Yes")
        & (df["Announced_Year"] >= 2020)
    )
    df = df.loc[mask].copy()
    df["npr_price"] = df["Price_EUR"].astype(float) * EUR_TO_NPR

    def to_tier(row):
        if row["npr_price"] >= 80000 or row.get("Chipset_Is_Flagship", 0) == 1:
            return "Flagship"
        if row["npr_price"] >= 25000:
            return "Mid"
        return "Budget"

    df["tier"] = df.apply(to_tier, axis=1)
    df["gaming_score"] = (
        df["RAM_GB"].fillna(0) * 2.0
        + df["Refresh_Rate_Hz"].fillna(0) / 30.0
        + df["Chipset_Is_Flagship"].fillna(0) * 8.0
    )
    df["camera_score"] = df["Main_Camera_MP"].fillna(0) * 1.5 + df["Lens_Count"].fillna(0)
    df["battery_score"] = df["Battery_mAh"].fillna(0) / 100.0
    df["display_score"] = df["Refresh_Rate_Hz"].fillna(0)
    return df


def load_customers():
    df = pd.read_csv(CUSTOMER_CSV)
    df["purchase_date_dt"] = pd.to_datetime(df["purchase_date"], errors="coerce")
    df["last_active_dt"] = pd.to_datetime(df["last_active_at"], errors="coerce")
    df["recency_ts"] = df[["last_active_dt", "purchase_date_dt"]].max(axis=1)
    df = df.sort_values("recency_ts", ascending=False)
    first_row = df.groupby("customer_id", as_index=False).first()
    agg = df.groupby("customer_id").agg(
        n_past_purchases=("customer_id", "count"),
        avg_purchase_amount=("purchase_amount_npr", "mean"),
        avg_rating=("rating", "mean"),
    )
    out = first_row.merge(agg, on="customer_id", how="left")
    out["purchase_amount_npr"] = out["avg_purchase_amount"]
    out["rating"] = out["avg_rating"]
    out = out.drop(
        columns=[
            "recency_ts", "purchase_date_dt", "last_active_dt",
            "avg_purchase_amount", "avg_rating",
            "mobile_brand_purchased", "mobile_model_purchased",
            "purchase_date", "purchase_amount_npr", "rating",
            "browsing_history", "wishlist", "review", "last_active_at",
        ],
        errors="ignore",
    )
    return out


def pick_geo(customer_id):
    u = hash_unit(f"geo:{customer_id}")
    province = weighted_pick(u, list(PROVINCE_WEIGHTS.keys()), list(PROVINCE_WEIGHTS.values()))

    districts = list(NEPAL_LOCATIONS[province].keys())
    district_weights = [3.0 if d in URBAN_DISTRICTS else 1.0 for d in districts]
    u2 = hash_unit(f"geo-district:{customer_id}")
    district = weighted_pick(u2, districts, district_weights)

    locations = NEPAL_LOCATIONS[province][district]
    loc_weights = [3.0 if loc in URBAN_LOCATIONS else 1.0 for loc in locations]
    u3 = hash_unit(f"geo-location:{customer_id}")
    location = weighted_pick(u3, locations, loc_weights)
    return province, district, location


def assign_features(row):
    cid = row["customer_id"]
    avg_spend = float(row.get("average_spend_npr", 50000) or 50000)
    spend_std = max(8000, avg_spend * 0.10)
    rnd = np.random.default_rng(hash_int(f"feat:{cid}"))

    avg_spend = max(8000, avg_spend + rnd.normal(0, spend_std))
    if avg_spend < 25000:
        bmin = int(rnd.integers(7000, 18000))
        bmax = int(rnd.integers(18000, 35000))
        tier = "Budget"
    elif avg_spend < 80000:
        bmin = int(rnd.integers(20000, 45000))
        bmax = int(rnd.integers(45000, 90000))
        tier = "Mid"
    else:
        bmin = int(rnd.integers(70000, 120000))
        bmax = int(rnd.integers(120000, 250000))
        tier = "Flagship"
    bmin = max(5000, bmin)
    bmax = max(bmin + 5000, bmax)

    loyalty = float(row.get("__brand_loyalty__", 0.5))

    interests = {
        "gaming_interest": 50.0,
        "camera_interest": 50.0,
        "battery_interest": 50.0,
        "display_interest": 50.0,
        "performance_interest": 50.0,
        "software_interest": 50.0,
        "value_interest": 50.0,
    }
    cat = row.get("preferred_category", "")
    for k, v in category_to_interests(cat).items():
        interests[k] = interests.get(k, 50.0) + v
    pb = row.get("preferred_brand", "")
    for k, v in brand_to_interests(pb).items():
        interests[k] = interests.get(k, 50.0) + v
    for k in interests:
        interests[k] = clamp(interests[k] + rnd.normal(0, 6), 0, 100)

    if tier == "Budget":
        interests["min_ram_gb"] = 4
        interests["min_storage_gb"] = 64
        interests["chipset_tier"] = "Budget"
        interests["min_refresh_rate_hz"] = 60
        interests["min_battery_mah"] = 4500
    elif tier == "Mid":
        interests["min_ram_gb"] = 6
        interests["min_storage_gb"] = 128
        interests["chipset_tier"] = "Mid"
        interests["min_refresh_rate_hz"] = 90
        interests["min_battery_mah"] = 5000
    else:
        interests["min_ram_gb"] = 8
        interests["min_storage_gb"] = 256
        interests["chipset_tier"] = "Flagship"
        interests["min_refresh_rate_hz"] = 120
        interests["min_battery_mah"] = 5000

    if interests["gaming_interest"] >= 70 and interests["min_ram_gb"] < 8:
        interests["min_ram_gb"] = 8
    if interests["camera_interest"] >= 80 and interests["min_storage_gb"] < 128:
        interests["min_storage_gb"] = 128

    interests["brand_loyalty_score"] = loyalty
    interests["budget_min_npr"] = bmin
    interests["budget_max_npr"] = bmax
    apply_internal_consistency(interests)
    archetype = choose_archetype(interests)
    return interests, archetype, tier


def build_brand_loyalty_map():
    df = pd.read_csv(CUSTOMER_CSV)
    out = {}
    for cid, grp in df.groupby("customer_id"):
        if grp.empty:
            continue
        pref = grp["preferred_brand"].dropna().mode()
        pref = pref.iloc[0] if not pref.empty else None
        if not pref:
            out[cid] = 0.5
            continue
        match = (grp["mobile_brand_purchased"] == pref).sum()
        share = match / max(1, len(grp))
        out[cid] = round(share, 3)
    return out


def assign_phone(customer_id, preferred_brand, brand_loyalty_score, budget_max_npr,
                 archetype, phones):
    target_brand = normalize_brand(preferred_brand)

    recent_model = customer_last_model.get(customer_id, "")
    norm_recent = normalize_name(recent_model)
    if norm_recent and norm_recent in phone_norm_index:
        recent_brand = phone_brand_index.get(norm_recent, "")
        if recent_brand == target_brand:
            return phone_norm_index[norm_recent]

    brand_candidates = phones.index[phones["Brand_norm"] == target_brand].tolist()
    if not brand_candidates:
        brand_candidates = phones.index.tolist()

    pick_idx = hash_int(f"phone:{customer_id}") % len(brand_candidates)
    return phones.loc[brand_candidates[pick_idx], "Model_Name"]


def build_behavior(row, brand_loyalty_score, rnd, archetype):
    n_past = int(row.get("n_past_purchases", 1) or 1)
    purchase_freq = float(row.get("purchase_frequency_per_year", 1.2) or 1.2)
    purchase_freq = clamp(purchase_freq + rnd.normal(0, 0.2), 0.2, 6.0)
    n_past = max(1, n_past)
    avg_session = clamp(rnd.normal(12, 5), 2, 30)
    search_freq = max(1, int(rnd.normal(8, 4)))
    compare_freq = max(0, int(rnd.normal(4, 3)))
    ctr = clamp(rnd.normal(0.35, 0.12), 0.05, 0.95)
    recency_days = max(0, int(rnd.normal(45, 60)))
    avg_rating_given = clamp(rnd.normal(4.0, 0.6), 1, 5)
    wishlist_conv = clamp(rnd.normal(0.25, 0.15), 0.0, 0.95)
    accessory_aff = clamp(rnd.normal(0.4, 0.2), 0.0, 1.0)
    if archetype == "Budget Buyer":
        ctr = max(0.15, ctr - 0.05)
        accessory_aff = max(0.0, accessory_aff - 0.1)
    if archetype == "Hardcore Gamer":
        avg_session = max(avg_session, 15)
        search_freq = max(search_freq, 12)
    if archetype == "Mobile Photographer":
        accessory_aff = min(1.0, accessory_aff + 0.15)
    return {
        "purchase_frequency_per_year": round(purchase_freq, 2),
        "n_past_purchases": n_past,
        "avg_session_minutes": round(avg_session, 1),
        "search_freq_per_week": int(search_freq),
        "compare_freq_per_week": int(compare_freq),
        "click_through_rate": round(ctr, 2),
        "recency_days": int(recency_days),
        "avg_rating_given": round(avg_rating_given, 1),
        "wishlist_conversion_rate": round(wishlist_conv, 2),
        "accessory_affinity": round(accessory_aff, 2),
    }


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


def normalize_brand(brand):
    if not isinstance(brand, str):
        return ""
    return BRAND_ALIASES.get(brand.strip(), brand.strip())


customer_last_model = {}
phone_norm_index = {}
phone_brand_index = {}


def main():
    np.random.seed(SEED)
    random.seed(SEED)

    print("Loading phone catalog...")
    phones = load_phones().reset_index(drop=True)
    phones["Brand_norm"] = phones["Brand"].apply(normalize_brand)
    print(f"  {len(phones)} phones in catalog")

    print("Loading customer transactions...")
    customers = load_customers()
    print(f"  {len(customers)} unique customers")

    print("Computing brand loyalty...")
    loyalty_map = build_brand_loyalty_map()
    customers["__brand_loyalty__"] = customers["customer_id"].map(loyalty_map).fillna(0.5)

    print("Building phone name index...")
    global phone_norm_index, phone_brand_index
    for _, row in phones.iterrows():
        norm = normalize_name(row["Model_Name"])
        phone_norm_index[norm] = row["Model_Name"]
        phone_brand_index[norm] = row["Brand_norm"]

    print("Loading last-purchased-model map...")
    raw = pd.read_csv(CUSTOMER_CSV)
    raw["purchase_date_dt"] = pd.to_datetime(raw["purchase_date"], errors="coerce")
    raw = raw.sort_values("purchase_date_dt", ascending=False)
    for cid, grp in raw.groupby("customer_id"):
        if not grp.empty:
            customer_last_model[cid] = grp.iloc[0]["mobile_model_purchased"]

    brand_set = set(phones["Brand_norm"].unique())

    rows = []
    print("Generating per-customer features...")
    for _, row in customers.iterrows():
        cid = row["customer_id"]
        province, district, location = pick_geo(cid)
        interests, archetype, tier = assign_features(row)

        pref_brand = row.get("preferred_brand", "") or "Samsung"
        if normalize_brand(pref_brand) not in brand_set:
            pref_brand = "Samsung"

        rnd = np.random.default_rng(hash_int(f"beh:{cid}"))
        behavior = build_behavior(row, interests["brand_loyalty_score"], rnd, archetype)

        channel = random.choices(CHANNELS, weights=CHANNEL_WEIGHTS, k=1)[0]

        model_name = assign_phone(
            cid, pref_brand, interests["brand_loyalty_score"],
            interests["budget_max_npr"], archetype, phones,
        )

        out = {
            "customer_id": cid,
            "customer_name": row["customer_name"],
            "province": province,
            "district": district,
            "location": location,
            "age": int(row["age"]) if pd.notna(row["age"]) else 30,
            "gender": row["gender"] if pd.notna(row["gender"]) else "Other",
            "budget_min_npr": int(interests["budget_min_npr"]),
            "budget_max_npr": int(interests["budget_max_npr"]),
            "preferred_brand": pref_brand,
            "brand_loyalty_score": round(float(interests["brand_loyalty_score"]), 2),
            "gaming_interest": round(float(interests["gaming_interest"]), 1),
            "camera_interest": round(float(interests["camera_interest"]), 1),
            "battery_interest": round(float(interests["battery_interest"]), 1),
            "display_interest": round(float(interests["display_interest"]), 1),
            "performance_interest": round(float(interests["performance_interest"]), 1),
            "software_interest": round(float(interests["software_interest"]), 1),
            "value_interest": round(float(interests["value_interest"]), 1),
            "min_ram_gb": int(interests["min_ram_gb"]),
            "min_storage_gb": int(interests["min_storage_gb"]),
            "chipset_tier": interests["chipset_tier"],
            "min_refresh_rate_hz": int(interests["min_refresh_rate_hz"]),
            "min_battery_mah": int(interests["min_battery_mah"]),
            "purchase_frequency_per_year": behavior["purchase_frequency_per_year"],
            "n_past_purchases": behavior["n_past_purchases"],
            "avg_session_minutes": behavior["avg_session_minutes"],
            "search_freq_per_week": behavior["search_freq_per_week"],
            "compare_freq_per_week": behavior["compare_freq_per_week"],
            "click_through_rate": behavior["click_through_rate"],
            "recency_days": behavior["recency_days"],
            "avg_rating_given": behavior["avg_rating_given"],
            "interaction_channel": channel,
            "wishlist_conversion_rate": behavior["wishlist_conversion_rate"],
            "accessory_affinity": behavior["accessory_affinity"],
            "model_name": model_name,
            "true_archetype": archetype,
        }
        rows.append(out)

    df = pd.DataFrame(rows)
    df = df[[
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
    ]]

    out_csv = OUT_DIR / "customer_segmentation_dataset.csv"
    try:
        if out_csv.exists():
            out_csv.unlink()
    except PermissionError:
        print(f"WARNING: could not remove {out_csv}; it may be open in another program.")
        out_csv = OUT_DIR / "customer_segmentation_dataset.new.csv"
        if out_csv.exists():
            out_csv.unlink()
    df.to_csv(out_csv, index=False)
    print(f"Wrote {out_csv} ({len(df)} rows)")

    write_summary(df, phones, out_csv)
    print("Done.")


def write_summary(df, phones, out_csv):
    lines = []
    lines.append("# Customer Segmentation Dataset - Summary")
    lines.append("")
    lines.append(f"- Rows: **{len(df)}**")
    lines.append(f"- Unique customers: **{df['customer_id'].nunique()}**")
    lines.append(f"- Unique customer names: **{df['customer_name'].nunique()}**")
    lines.append(f"- Output file: `{out_csv.relative_to(PROJECT_ROOT)}`")
    lines.append("")
    lines.append("## Province distribution")
    lines.append("")
    lines.append("| Province | Count | % |")
    lines.append("|---|---:|---:|")
    for prov, n in df["province"].value_counts().items():
        lines.append(f"| {prov} | {n} | {n / len(df) * 100:.1f}% |")
    lines.append("")

    lines.append("## Top 15 districts")
    lines.append("")
    lines.append("| District | Count |")
    lines.append("|---|---:|")
    for d, n in df["district"].value_counts().head(15).items():
        lines.append(f"| {d} | {n} |")
    lines.append("")

    lines.append("## Top 15 locations")
    lines.append("")
    lines.append("| Location | Count |")
    lines.append("|---|---:|")
    for loc, n in df["location"].value_counts().head(15).items():
        lines.append(f"| {loc} | {n} |")
    lines.append("")

    lines.append("## Gender distribution")
    lines.append("")
    lines.append("| Gender | Count | % |")
    lines.append("|---|---:|---:|")
    for g, n in df["gender"].value_counts().items():
        lines.append(f"| {g} | {n} | {n / len(df) * 100:.1f}% |")
    lines.append("")

    lines.append("## Preferred brand distribution")
    lines.append("")
    lines.append("| Brand | Count | % |")
    lines.append("|---|---:|---:|")
    for b, n in df["preferred_brand"].value_counts().items():
        lines.append(f"| {b} | {n} | {n / len(df) * 100:.1f}% |")
    lines.append("")

    lines.append("## Archetype distribution")
    lines.append("")
    lines.append("| Archetype | Count | % |")
    lines.append("|---|---:|---:|")
    for a, n in df["true_archetype"].value_counts().items():
        lines.append(f"| {a} | {n} | {n / len(df) * 100:.1f}% |")
    lines.append("")

    lines.append("## Chipset tier distribution")
    lines.append("")
    lines.append("| Tier | Count | % |")
    lines.append("|---|---:|---:|")
    for t, n in df["chipset_tier"].value_counts().items():
        lines.append(f"| {t} | {n} | {n / len(df) * 100:.1f}% |")
    lines.append("")

    lines.append("## Numeric columns (min / mean / max)")
    lines.append("")
    lines.append("| Column | min | mean | max |")
    lines.append("|---|---:|---:|---:|")
    for col in [
        "age", "budget_min_npr", "budget_max_npr", "brand_loyalty_score",
        "gaming_interest", "camera_interest", "battery_interest", "display_interest",
        "performance_interest", "software_interest", "value_interest",
        "min_ram_gb", "min_storage_gb", "min_refresh_rate_hz", "min_battery_mah",
        "purchase_frequency_per_year", "n_past_purchases",
        "avg_session_minutes", "search_freq_per_week", "compare_freq_per_week",
        "click_through_rate", "recency_days", "avg_rating_given",
        "wishlist_conversion_rate", "accessory_affinity",
    ]:
        lines.append(
            f"| {col} | {df[col].min():.2f} | {df[col].mean():.2f} | {df[col].max():.2f} |"
        )
    lines.append("")

    lines.append("## Model_name coverage")
    lines.append("")
    matched = df["model_name"].isin(phones["Model_Name"]).sum()
    lines.append(f"- Rows whose `model_name` exists in GSM Arena: **{matched} / {len(df)}** "
                 f"({matched / len(df) * 100:.1f}%)")
    lines.append(f"- Unique phones assigned: **{df['model_name'].nunique()}**")
    lines.append("")
    lines.append("### Top 15 assigned phones")
    lines.append("")
    lines.append("| Model | Count |")
    lines.append("|---|---:|")
    for m, n in df["model_name"].value_counts().head(15).items():
        lines.append(f"| {m} | {n} |")
    lines.append("")

    out_md = OUT_DIR / "dataset_summary.md"
    out_md.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {out_md}")


if __name__ == "__main__":
    main()
