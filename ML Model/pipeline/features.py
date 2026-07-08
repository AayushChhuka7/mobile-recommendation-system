"""Feature engineering for NEW phone rows.

The model and scoring pipeline operate on the already-engineered
`After_EDA_and_Feature_ENginering.csv` (152 columns). When a user wants
to score a new phone that isn't in the dataset, this module is run
first to produce the same 152-column row.

Functions are direct ports of the corresponding notebook cells in
`EDA_and_Feature_Engineering_to_Dataset.ipynb`:
    engineer_network              -> cell 12
    engineer_status               -> cell 23
    engineer_dimensions           -> cell 28
    engineer_sim_features         -> cell 31
    engineer_display              -> cell 32 (panel + HDR + LTPO)
    engineer_os_features          -> cell 41 (extended: software support)
    engineer_storage_type         -> cell 48
    engineer_camera_video_features-> cell 53 + groupwise fill (cell 54)
    engineer_wifi_features        -> cell 59
    engineer_gps_features         -> cell 64
    engineer_sensors_features     -> cell 66
    engineer_color_features       -> cell 68
    engineer_fm_radio             -> cell 70
    fill_missing                  -> cell 38

Each function takes a dataframe and returns a new dataframe with the
new columns appended.  They are pure and idempotent so the order
matters only for column dependencies, not for re-running.

Input schema expected: the 100 columns produced by
`Preprocessing_all_dataset.ipynb` (`GSMArena_Cleaned_Dataset.csv`).
Output schema: 152 columns matching the trained XGBoost feature list
(minus the 32 provenance / identifier columns that train.py drops).
"""

from __future__ import annotations

import re
from typing import Dict, Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# network  (cell 12)
# ---------------------------------------------------------------------------
def engineer_network(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["Network_Technology"] = (
        df["Network_Technology"].fillna("No cellular connectivity").astype(str)
    )
    df["Has_5G"] = df["Network_Technology"].str.contains("5G", case=False).astype(int)
    df["No_Cellular"] = df["Network_Technology"].eq("No cellular connectivity").astype(int)

    def highest_gen(text: str) -> int:
        text = text.upper()
        if "5G" in text: return 5
        if "LTE" in text: return 4
        if any(x in text for x in ["HSPA", "UMTS", "EVDO", "CDMA2000"]): return 3
        if any(x in text for x in ["GSM", "CDMA"]): return 2
        return 0

    df["Max_Network_Gen"] = df["Network_Technology"].apply(highest_gen).astype(int)
    return df


# ---------------------------------------------------------------------------
# status  (cell 23)
# ---------------------------------------------------------------------------
def engineer_status(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["Status"] = df["Status"].fillna("Unknown").astype(str)

    def cat(s: str) -> str:
        s = s.lower()
        if s.startswith("available"): return "Available"
        if s.startswith("discontinued"): return "Discontinued"
        if s.startswith("cancelled"): return "Cancelled"
        if s.startswith("coming soon"): return "Coming_Soon"
        if s.startswith("rumored"): return "Rumored"
        return "Unknown"

    df["Status_Category"] = df["Status"].apply(cat)
    df["Is_Purchasable"] = (df["Status_Category"] == "Available").astype(int)
    yr = df["Status"].str.extract(r"release[ds]?\s+(\d{4})", flags=re.IGNORECASE)
    df["Release_Year"] = pd.to_numeric(yr[0], errors="coerce")
    return df


# ---------------------------------------------------------------------------
# dimensions  (cell 28)
# ---------------------------------------------------------------------------
def engineer_dimensions(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["Dimensions"] = df["Dimensions"].fillna("Unknown").astype(str)

    def extract(s: str):
        mm_part = s.split("(")[0]
        nums = re.findall(r"[-+]?\d*\.\d+|\d+", mm_part)
        if len(nums) < 3:
            return (np.nan, np.nan, np.nan)
        return float(nums[0]), float(nums[1]), float(nums[2])

    hwd = df["Dimensions"].apply(extract)
    df["Height_mm"] = hwd.apply(lambda t: t[0])
    df["Width_mm"] = hwd.apply(lambda t: t[1])
    df["Thickness_mm"] = hwd.apply(lambda t: t[2])
    df["Volume_cm3"] = (df["Height_mm"] * df["Width_mm"] * df["Thickness_mm"]) / 1000
    df["Aspect_Ratio"] = df["Height_mm"] / df["Width_mm"]
    if "Weight_g" in df.columns:
        df["Density_g_per_cm3"] = df["Weight_g"] / df["Volume_cm3"]
    return df


# ---------------------------------------------------------------------------
# display  (cell 32 — panel + HDR + LTPO + brightness)
# ---------------------------------------------------------------------------
def engineer_display(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Display_Type" in df.columns:
        panel = df["Display_Type"].fillna("Unknown").astype(str)
        df["Display_Panel_Type"] = panel
        df["Display_Is_LTPO"] = panel.str.contains("LTPO", case=False).astype(int)
        df["Display_Is_Foldable"] = panel.str.contains("Foldable", case=False).astype(int)
        df["Display_Has_HDR"] = panel.str.contains("HDR", case=False).astype(int)
    if "Display_Brightness_nits" in df.columns:
        df["Display_Max_Brightness_nits"] = pd.to_numeric(
            df["Display_Brightness_nits"], errors="coerce"
        )
    return df


# ---------------------------------------------------------------------------
# OS  (cell 41)
# ---------------------------------------------------------------------------
SKIN_TO_BRAND: Dict[str, str] = {
    "One UI": "Samsung", "HyperOS": "Xiaomi", "MIUI": "Xiaomi",
    "ColorOS": "OPPO", "OxygenOS": "OnePlus", "Realme UI": "Realme",
    "Funtouch": "Vivo", "OriginOS": "Vivo", "EMUI": "Huawei",
    "MagicOS": "Honor", "Magic UI": "Honor", "ZenUI": "ASUS",
    "Flyme": "Meizu", "RedMagic": "Nubia", "Nothing OS": "Nothing",
    "Hello UI": "Motorola", "XOS": "Infinix", "HIOS": "Tecno",
    "itel OS": "itel", "TouchWiz": "Samsung",
}


def engineer_os_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["OS"] = df["OS"].fillna("Unknown").astype(str).str.strip()

    def family(t: str) -> str:
        t = t.lower()
        if "ipados" in t: return "iPadOS"
        if "ios" in t: return "iOS"
        if "android" in t: return "Android"
        if "harmonyos" in t or "harmony os" in t: return "HarmonyOS"
        if "windows" in t: return "Windows"
        if "symbian" in t: return "Symbian"
        if "blackberry" in t: return "BlackBerry"
        if "kaios" in t: return "KaiOS"
        if "firefox" in t: return "Firefox OS"
        return "Other"

    df["OS_Family"] = df["OS"].apply(family)

    def android_major(t: str):
        m = re.search(r"android\s*(\d+)", t.lower())
        return int(m.group(1)) if m else np.nan

    def android_minor(t: str):
        m = re.search(r"android\s*\d+\.(\d+)", t.lower())
        return int(m.group(1)) if m else np.nan

    df["Android_Major_Version"] = df["OS"].apply(android_major)
    df["Android_Minor_Version"] = df["OS"].apply(android_minor)

    def skin(t: str) -> str:
        for s in SKIN_TO_BRAND:
            if s.lower() in t.lower():
                return s
        return "Stock"

    df["OS_Skin"] = df["OS"].apply(skin)
    df["Has_Custom_Skin"] = (df["OS_Skin"] != "Stock").astype(int)

    # ---- software-support columns (rest of EDA cell 41) ----
    def major_upgrade(t: str):
        t = t.lower()
        m = re.search(r"up to\s*(\d+)\s*major android upgrade", t)
        if m:
            return int(m.group(1))
        m = re.search(r"(\d+)\s*major android upgrade", t)
        if m:
            return int(m.group(1))
        return np.nan

    df["Guaranteed_Android_Upgrades"] = df["OS"].apply(major_upgrade)

    def security_years(t: str):
        t = t.lower()
        m = re.search(r"(\d+)\s*year[s]?\s*of security", t)
        return int(m.group(1)) if m else np.nan

    df["Security_Update_Years"] = df["OS"].apply(security_years)

    df["Is_Go_Edition"] = (
        df["OS"].str.contains("go edition", case=False, na=False).astype(int)
    )
    df["No_Google_Play_Services"] = (
        df["OS"].str.contains("no google play services", case=False, na=False).astype(int)
    )
    df["Is_Beta_OS"] = (
        df["OS"]
        .str.contains("beta|developer preview", case=False, regex=True, na=False)
        .astype(int)
    )
    df["Enterprise_OS"] = (
        df["OS"].str.contains("enterprise", case=False, na=False).astype(int)
    )

    # ---- groupwise + global median fill for Android version, then
    #      impute the upgrade/security counts with 0 (cell 41 logic) ----
    for col in ["Android_Major_Version", "Android_Minor_Version"]:
        if {"Brand", "Announced_Year"}.issubset(df.columns):
            df[col] = (
                df.groupby(["Brand", "Announced_Year"], dropna=False)[col]
                .transform(lambda x: x.fillna(x.median()))
            )
        df[col] = df[col].fillna(df[col].median())

    df["Guaranteed_Android_Upgrades"] = df["Guaranteed_Android_Upgrades"].fillna(0)
    df["Security_Update_Years"] = df["Security_Update_Years"].fillna(0)

    df["Long_Term_Support"] = (df["Guaranteed_Android_Upgrades"] >= 4).astype(int)
    df["Software_Support_Score"] = (
        df["Guaranteed_Android_Upgrades"] * 12
        + df["Security_Update_Years"] * 12
    )
    return df


# ---------------------------------------------------------------------------
# SIM  (cell 31)
# ---------------------------------------------------------------------------
def engineer_sim_features(df: pd.DataFrame) -> pd.DataFrame:
    """Parse `SIM_Type` into eSIM / slot / hybrid / dual flags."""
    df = df.copy()
    if "SIM_Type" not in df.columns:
        return df
    df["SIM_Type"] = df["SIM_Type"].fillna("Unknown").astype(str)

    def parse_sim(text: str) -> pd.Series:
        t = text.lower()
        has_esim = int("esim" in t)
        has_hybrid = int("hybrid" in t)

        if "quad sim" in t:
            slot_count = 4
        elif "triple sim" in t:
            slot_count = 3
        elif (
            "dual sim" in t
            or t.count("nano-sim") >= 2
            or t.count("micro-sim") >= 2
            or t.count("mini-sim") >= 2
            or ("nano-sim" in t and "micro-sim" in t)
            or ("nano-sim" in t and "mini-sim" in t)
        ):
            slot_count = 2
        elif "no cellular" in t or t.strip() == "no" or "non-removable" in t:
            slot_count = 0
        elif any(x in t for x in ["single sim", "nano-sim", "micro-sim", "mini-sim", "esim"]):
            slot_count = 1
        else:
            slot_count = 1

        if "nano-sim" in t:
            sim_type = "Nano-SIM"
        elif "micro-sim" in t:
            sim_type = "Micro-SIM"
        elif "mini-sim" in t:
            sim_type = "Mini-SIM"
        elif has_esim:
            sim_type = "eSIM-only"
        else:
            sim_type = "Unknown"

        is_dual_sim = int(slot_count >= 2)
        return pd.Series([has_esim, slot_count, sim_type, has_hybrid, is_dual_sim])

    df[["Has_eSIM", "SIM_Slot_Count", "SIM_Physical_Type", "Has_Hybrid_SIM", "Is_Dual_SIM"]] = (
        df["SIM_Type"].apply(parse_sim)
    )
    return df


# ---------------------------------------------------------------------------
# storage  (cell 48)
# ---------------------------------------------------------------------------
_STORAGE_FAMILY_SCORE = {
    "eMMC4": 0, "eMMC5": 1, "uMCP": 2, "UFS2": 3, "UFS3": 4, "UFS": 3,
    "eMMC": 1, "UFS4": 5, "NVMe": 5, "Other": np.nan,
}
_STORAGE_FAMILY_TIER = {
    "eMMC4": "Entry", "eMMC5": "Budget", "uMCP": "Budget", "UFS2": "Mid",
    "UFS3": "Premium", "UFS": "Mid", "eMMC": "Budget", "UFS4": "Flagship",
    "NVMe": "Flagship", "Other": "Unknown",
}


def engineer_storage_type(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Storage_Type" not in df.columns:
        return df
    df["Storage_Type"] = (
        df["Storage_Type"].fillna("Unknown").astype(str).str.strip()
    )

    def family(text: str) -> str:
        t = text.lower()
        if "nvme" in t:
            return "NVMe"
        if re.search(r"ufs\s*4", t):
            return "UFS4"
        if re.search(r"ufs\s*3", t):
            return "UFS3"
        if re.search(r"ufs\s*2", t):
            return "UFS2"
        if "umcp" in t or "emcp" in t:
            return "uMCP"
        if re.search(r"emmc\s*5|emmc5|еmmc", t):
            return "eMMC5"
        if re.search(r"emmc\s*4", t):
            return "eMMC4"
        if "ufs" in t:
            return "UFS"
        if "emmc" in t:
            return "eMMC"
        return "Other"

    df["Storage_Family"] = df["Storage_Type"].apply(family)
    premium = ["UFS3", "UFS4", "NVMe"]
    df["Premium_Storage"] = df["Storage_Family"].isin(premium).astype(int)
    df["Mixed_Storage"] = (
        df["Storage_Type"]
        .str.count(r"UFS|eMMC|NVMe|uMCP|eMCP", flags=re.IGNORECASE)
        .gt(1)
        .astype(int)
    )
    df["Storage_Performance_Score"] = df["Storage_Family"].map(_STORAGE_FAMILY_SCORE)
    df["Storage_Tier"] = df["Storage_Family"].map(_STORAGE_FAMILY_TIER)
    df = df.drop(columns=["Storage_Type"])
    return df


# ---------------------------------------------------------------------------
# camera_video  (cell 53 + groupwise fill from cell 54)
# ---------------------------------------------------------------------------
def engineer_camera_video_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Camera_Video" not in df.columns:
        return df
    df["Camera_Video"] = df["Camera_Video"].fillna("Unknown").astype(str)

    def max_resolution(text: str):
        t = text.lower()
        if "8k" in t:
            return 5
        if "6k" in t:
            return 4
        if "4k" in t:
            return 3
        if "1440p" in t or "2k" in t:
            return 2
        if "1080p" in t:
            return 1
        if any(x in t for x in ["720p", "480p", "320p", "cif", "qcif"]):
            return 0
        return np.nan

    df["Video_Max_Resolution_Tier"] = df["Camera_Video"].apply(max_resolution)
    df["Video_Has_4K_Plus"] = (
        df["Camera_Video"].str.contains(r"4k|6k|8k", case=False, regex=True).astype(int)
    )
    df["Video_Has_8K"] = (
        df["Camera_Video"].str.contains(r"8k", case=False, regex=True).astype(int)
    )
    df["Video_Has_Stabilization"] = (
        df["Camera_Video"]
        .str.contains(r"gyro-eis|ois|eis", case=False, regex=True)
        .astype(int)
    )
    df["Video_Has_HDR"] = (
        df["Camera_Video"]
        .str.contains(
            r"hdr|hdr10|hdr10\+|dolby vision|hdr vivid",
            case=False,
            regex=True,
        )
        .astype(int)
    )
    df["Video_Has_High_FPS"] = (
        df["Camera_Video"]
        .str.contains(r"120fps|240fps|480fps|960fps", case=False, regex=True)
        .astype(int)
    )

    # groupwise fill for Video_Max_Resolution_Tier (cell 54)
    if "Chipset" in df.columns:
        df["Video_Max_Resolution_Tier"] = (
            df.groupby("Chipset", dropna=False)["Video_Max_Resolution_Tier"]
            .transform(lambda x: x.fillna(x.median()))
        )
    if {"Brand", "Announced_Year"}.issubset(df.columns):
        df["Video_Max_Resolution_Tier"] = (
            df.groupby(["Brand", "Announced_Year"], dropna=False)[
                "Video_Max_Resolution_Tier"
            ]
            .transform(lambda x: x.fillna(x.median()))
        )
    df["Video_Max_Resolution_Tier"] = df["Video_Max_Resolution_Tier"].fillna(
        df["Video_Max_Resolution_Tier"].median()
    )
    return df


# ---------------------------------------------------------------------------
# wifi  (cell 59)
# ---------------------------------------------------------------------------
def engineer_wifi_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "WiFi" not in df.columns:
        return df
    df["WiFi"] = df["WiFi"].fillna("No WiFi").astype(str)

    def gen(text: str) -> int:
        t = text.lower()
        if re.search(r"\b802\.11be\b|\bwi[- ]?fi\s*7\b|\b802\.11\s*7\b", t):
            return 7
        if re.search(r"\b802\.11ax\b|\bwi[- ]?fi\s*6e\b|\bwi[- ]?fi\s*6\b|\b6e\b", t):
            return 6
        if re.search(r"\b802\.11ac\b|\bac\b", t):
            return 5
        if re.search(r"\b802\.11n\b|\bn\b", t):
            return 4
        if re.search(r"\b802\.11g\b|\bg\b", t):
            return 3
        if re.search(r"\b802\.11b\b|\bb\b", t):
            return 2
        if re.search(r"\b802\.11a\b|\ba\b", t):
            return 1
        return 0

    df["WiFi_Generation"] = df["WiFi"].apply(gen)
    df["WiFi_Dual_Band"] = df["WiFi"].str.contains("dual-band", case=False).astype(int)
    df["WiFi_Tri_Band"] = df["WiFi"].str.contains("tri-band", case=False).astype(int)
    df["Has_WiFi_Direct"] = (
        df["WiFi"]
        .str.contains("wi-fi direct|wifi direct", case=False, regex=True)
        .astype(int)
    )
    df["Has_Hotspot"] = df["WiFi"].str.contains("hotspot", case=False).astype(int)
    df = df.drop(columns=["WiFi"])
    return df


# ---------------------------------------------------------------------------
# gps  (cell 64)
# ---------------------------------------------------------------------------
def engineer_gps_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "GPS" not in df.columns:
        return df
    df["GPS"] = df["GPS"].fillna("Unknown").astype(str)

    def gnss_count(text: str) -> int:
        t = text.lower()
        if t.strip() in ["no", "unknown"]:
            return 0
        systems = ["gps", "glonass", "galileo", "bds", "qzss", "navic"]
        return sum(1 for s in systems if s in t)

    df["GNSS_System_Count"] = df["GPS"].apply(gnss_count)
    df["Has_Multi_GNSS"] = (df["GNSS_System_Count"] >= 2).astype(int)
    df["GPS_Has_Dual_Frequency"] = (
        df["GPS"].str.contains(r"l1\+l5|l1\s*\+\s*l5", case=False, regex=True).astype(int)
    )
    df["Has_GPS"] = (
        (~df["GPS"].str.strip().str.lower().isin(["no", "unknown"])).astype(int)
    )
    df = df.drop(columns=["GPS"])
    return df


# ---------------------------------------------------------------------------
# sensors  (cell 66)
# ---------------------------------------------------------------------------
def engineer_sensors_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Sensors" not in df.columns:
        return df
    df["Sensors"] = df["Sensors"].fillna("Unknown").astype(str)
    df["Has_Fingerprint"] = (
        df["Sensors"].str.contains("fingerprint", case=False).astype(int)
    )

    def fingerprint_position(text: str) -> str:
        t = text.lower()
        if any(x in t for x in ["under display", "under-display", "under screen", "under-screen"]):
            return "Under_Display"
        if "side-mounted" in t or "side mounted" in t:
            return "Side_Mounted"
        if "rear-mounted" in t or "rear mounted" in t:
            return "Rear_Mounted"
        if "front-mounted" in t or "front mounted" in t:
            return "Front_Mounted"
        if "top-mounted" in t or "top mounted" in t:
            return "Top_Mounted"
        if "fingerprint" in t:
            return "Other"
        return "None"

    df["Fingerprint_Position"] = df["Sensors"].apply(fingerprint_position)
    df["Has_Face_Unlock"] = (
        df["Sensors"]
        .str.contains(r"face id|face recognition|face unlock|iris", case=False, regex=True)
        .astype(int)
    )
    df["Has_Gyro"] = df["Sensors"].str.contains("gyro", case=False).astype(int)
    df["Has_Compass"] = df["Sensors"].str.contains("compass", case=False).astype(int)
    df["Has_Barometer"] = df["Sensors"].str.contains("barometer", case=False).astype(int)
    df["Sensor_Count"] = df["Sensors"].apply(
        lambda x: 0 if x == "Unknown" else len(x.split(","))
    )
    df = df.drop(columns=["Sensors"])
    return df


# ---------------------------------------------------------------------------
# colors  (cell 68)
# ---------------------------------------------------------------------------
def engineer_color_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "Colors" not in df.columns:
        return df
    df["Color_Option_Count"] = df["Colors"].apply(
        lambda x: 0 if pd.isna(x) else len(str(x).split(","))
    )
    df = df.drop(columns=["Colors"])
    return df


# ---------------------------------------------------------------------------
# FM radio  (cell 70)
# ---------------------------------------------------------------------------
def engineer_fm_radio(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "FM_Radio" not in df.columns:
        return df
    df["FM_Radio"] = df["FM_Radio"].fillna("Unknown").astype(str)
    df["Has_FM_Radio"] = (
        df["FM_Radio"]
        .str.contains(r"\bfm radio\b|\byes\b", case=False, regex=True)
        .astype(int)
    )
    df["FM_Has_RDS"] = (
        df["FM_Radio"].str.contains(r"\brds\b", case=False, regex=True).astype(int)
    )
    df["FM_Can_Record"] = (
        df["FM_Radio"].str.contains("record", case=False).astype(int)
    )
    df = df.drop(columns=["FM_Radio"])
    return df


# ---------------------------------------------------------------------------
# missing-value fill  (cell 38 — groupwise, then global median)
# ---------------------------------------------------------------------------
def fill_missing(df: pd.DataFrame) -> pd.DataFrame:
    """Groupwise (Brand) + global-median impute.  Mutates a copy."""
    df = df.copy()

    for col in ["Height_mm", "Width_mm", "Thickness_mm"]:
        if col not in df.columns:
            continue
        df[col] = (
            df.groupby(["Brand", "Display_Size_inch"], dropna=False)[col]
            .transform(lambda x: x.fillna(x.median()))
        )
        df[col] = (
            df.groupby("Brand", dropna=False)[col]
            .transform(lambda x: x.fillna(x.median()))
        )
        df[col] = df[col].fillna(df[col].median())

    if {"Height_mm", "Width_mm", "Thickness_mm"}.issubset(df.columns):
        df["Volume_cm3"] = (df["Height_mm"] * df["Width_mm"] * df["Thickness_mm"]) / 1000
        df["Aspect_Ratio"] = df["Height_mm"] / df["Width_mm"]
    if "Volume_cm3" in df.columns and "Weight_g" in df.columns:
        df["Density_g_per_cm3"] = df["Weight_g"] / df["Volume_cm3"]

    if "Flash_Type" in df.columns:
        df["Flash_Type"] = (
            df.groupby("Brand", dropna=False)["Flash_Type"]
            .transform(
                lambda x: x.fillna(x.mode().iloc[0]) if not x.mode().empty else x
            )
        )
        df["Flash_Type"] = df["Flash_Type"].fillna("None")

    if "Release_Year" in df.columns and "Announced_Year" in df.columns:
        df["Release_Year"] = df["Release_Year"].fillna(df["Announced_Year"])
        df["Release_Year"] = (
            df.groupby("Brand", dropna=False)["Release_Year"]
            .transform(lambda x: x.fillna(x.median()))
        )
        df["Release_Year"] = df["Release_Year"].fillna(df["Release_Year"].median())

    if "Release_Year" in df.columns:
        latest = int(df["Release_Year"].max())
        df["Phone_Age_Years"] = latest - df["Release_Year"]

    if "Refresh_Rate_Hz" in df.columns and "Display_Refresh_Rate_Extracted" in df.columns:
        df["Refresh_Rate_Hz"] = df["Refresh_Rate_Hz"].fillna(df["Display_Refresh_Rate_Extracted"])
    if "Refresh_Rate_Hz" in df.columns:
        df["Refresh_Rate_Hz"] = df["Refresh_Rate_Hz"].fillna(60)

    if "Display_Max_Brightness_nits" in df.columns:
        def tier(x):
            if pd.isna(x): return "Unknown"
            if x < 500: return "Low"
            if x < 1000: return "Medium"
            if x < 2000: return "High"
            return "Ultra"
        df["Display_Brightness_Tier"] = df["Display_Max_Brightness_nits"].apply(tier)

    return df


def apply_imputation_snapshot(
    df: pd.DataFrame,
    medians: Dict[str, float],
    modes: Dict[str, str],
) -> pd.DataFrame:
    """Predict-time safe fill using a frozen snapshot of medians / modes."""
    df = df.copy()
    for col, val in medians.items():
        if col in df.columns:
            df[col] = df[col].fillna(val)
    for col, val in modes.items():
        if col in df.columns:
            df[col] = df[col].fillna(val)
    return df


# ---------------------------------------------------------------------------
# one-shot: turn a raw phone row into the engineered schema
# ---------------------------------------------------------------------------
def engineer_all(df: pd.DataFrame) -> pd.DataFrame:
    """Apply every feature engineering step in order, on a raw phone dataframe.

    Order matches the EDA notebook execution:
        1. network            (cell 12)
        2. status             (cell 23)
        3. dimensions         (cell 28)
        4. SIM                (cell 31)
        5. display            (cell 32)
        6. OS                 (cell 41, extended)
        7. storage            (cell 48)
        8. camera_video       (cell 53 + groupwise fill from 54)
        9. wifi               (cell 59)
       10. gps                (cell 64)
       11. sensors            (cell 66)
       12. color              (cell 68)
       13. fm_radio           (cell 70)
       14. fill_missing       (cell 38)
    """
    df = engineer_network(df)
    df = engineer_status(df)
    df = engineer_dimensions(df)
    df = engineer_sim_features(df)
    df = engineer_display(df)
    df = engineer_os_features(df)
    df = engineer_storage_type(df)
    df = engineer_camera_video_features(df)
    df = engineer_wifi_features(df)
    df = engineer_gps_features(df)
    df = engineer_sensors_features(df)
    df = engineer_color_features(df)
    df = engineer_fm_radio(df)
    df = fill_missing(df)
    return df
