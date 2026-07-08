"""
GSMArena COMPLETE Scraper — ALL Brands + ALL Features
======================================================
Scrapes every brand listed on GSMArena (126 brands, 10,000+ phones)
and extracts EVERY field shown on a phone spec page including:
  - All standard specs (Network, Body, Display, Platform, etc.)
  - Our Tests section (AnTuTu, GeekBench, 3DMark, Display, Battery)
  - EU Label section (Energy class, Battery cycles, Repairability)
  - Pricing table (per storage variant)
  - IP rating, SAR values, Model numbers

Run on YOUR LOCAL MACHINE:
    pip install requests beautifulsoup4 lxml
    python gsmarena_complete.py

Output:
    GSMArenaDataset/
        GSMArena_Master_ALL.csv     ← all brands combined
        Apple_2025.csv              ← per-brand files
        Samsung_2025.csv
        ...
        scraper_log.txt
"""

import requests
from bs4 import BeautifulSoup
import csv, os, time, random, logging, re
from datetime import datetime

# ================================================================
# CONFIGURATION
# ================================================================
DELAY_MIN     = 8        # Min seconds between requests (do not lower)
DELAY_MAX     = 20       # Max seconds between requests
MAX_RETRIES   = 3        # Retries per failed URL
OUTPUT_FOLDER = 'GSMArenaDataset'
MASTER_CSV    = 'GSMArena_Master_ALL.csv'
LOG_FILE      = 'scraper_log.txt'
BASE_URL      = 'https://www.gsmarena.com/'

# Update this to your actual browser User-Agent
# Chrome → F12 → Network → refresh → any request → Request Headers → User-Agent
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# ================================================================
# ALL 126 BRANDS FROM GSMARENA
# Set TARGET_BRANDS = None to scrape ALL of them
# Or set to a list of brand names to scrape only those
# ================================================================
TARGET_BRANDS = None   # ← None = scrape ALL brands

# To scrape only specific brands, use:
# TARGET_BRANDS = ['Apple', 'Samsung', 'Google']

# ================================================================
# LOGGING
# ================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE, encoding='utf-8'),
        logging.StreamHandler()
    ]
)
log = logging.getLogger(__name__)

# ================================================================
# HTTP SESSION
# ================================================================
SESSION = requests.Session()
SESSION.headers.update({
    'User-Agent':      USER_AGENT,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Referer':         BASE_URL,
    'DNT':             '1',
    'Upgrade-Insecure-Requests': '1',
})

# ================================================================
# WAIT BETWEEN REQUESTS
# ================================================================
def wait(extra=0):
    t = random.uniform(DELAY_MIN, DELAY_MAX) + extra
    log.info(f"  ⏳ Waiting {t:.1f}s ...")
    time.sleep(t)

# ================================================================
# FETCH WITH RETRY
# ================================================================
def fetch(url: str) -> BeautifulSoup | None:
    if not url.startswith('http'):
        url = BASE_URL + url

    for attempt in range(1, MAX_RETRIES + 1):
        wait()
        try:
            r = SESSION.get(url, timeout=15)
            log.info(f"  GET {url[:100]}  →  HTTP {r.status_code}")

            if r.status_code == 200:
                return BeautifulSoup(r.text, 'lxml')

            elif r.status_code == 403:
                log.error("  ❌ 403 — IP blocked. Switch to home Wi-Fi or mobile hotspot.")
                return None

            elif r.status_code == 429:
                backoff = 120 * attempt
                log.warning(f"  ⚠️  Rate limited. Sleeping {backoff}s ...")
                time.sleep(backoff)

            else:
                log.warning(f"  ⚠️  HTTP {r.status_code} (attempt {attempt})")

        except requests.exceptions.Timeout:
            log.warning(f"  ⚠️  Timeout (attempt {attempt})")
        except requests.exceptions.ConnectionError as e:
            log.error(f"  ❌ Connection error: {e}")
            time.sleep(20)

    log.error(f"  ❌ All retries failed: {url}")
    return None

# ================================================================
# STEP 0: CONNECTIVITY CHECK
# ================================================================
def check_connection() -> bool:
    log.info("STEP 0: Checking connectivity ...")
    try:
        r = SESSION.get(BASE_URL, timeout=10)
        if r.status_code == 403:
            log.error("  ❌ BLOCKED — run from home Wi-Fi or mobile hotspot")
            return False
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, 'lxml')
            t = soup.find('title')
            log.info(f"  ✅ Connected: {t.text.strip() if t else 'OK'}")
            return True
        log.error(f"  ❌ HTTP {r.status_code}")
        return False
    except Exception as e:
        log.error(f"  ❌ {e}")
        return False

# ================================================================
# STEP 1: GET ALL BRANDS
# Brand name extracted from href — reliable regardless of HTML changes
# href format: "apple-phones-48.php" → brand = "Apple"
# ================================================================
def get_all_brands() -> list[dict]:
    log.info("\n" + "="*60)
    log.info("STEP 1: Fetching all brands")
    log.info("="*60)

    soup = fetch('makers.php3')
    if not soup:
        return []

    table = soup.find('table')
    if not table:
        log.error("❌ Brand table not found")
        return []

    brands = []
    for a in table.find_all('a'):
        href = a.get('href', '')
        if not href:
            continue

        # Extract brand name from URL slug
        # "apple-phones-48.php"       → Apple
        # "samsung-phones-9.php"      → Samsung
        # "sony-ericsson-phones-7.php"→ Sony Ericsson
        # "benq-siemens-phones-20.php"→ BenQ-Siemens (keep hyphen between words)
        if '-phones-' in href:
            slug = href.split('-phones-')[0]         # "sony-ericsson"
            brand_name = slug.replace('-', ' ').title()  # "Sony Ericsson"
        else:
            continue

        # Phone count from span text
        spans = a.find_all('span')
        count = '?'
        for s in spans:
            nums = re.findall(r'\d+', s.get_text())
            if nums:
                count = nums[0]
                break

        brands.append({'name': brand_name, 'url': href, 'count': count})

    log.info(f"✅ Found {len(brands)} brands total")
    for b in brands:
        log.info(f"   {b['name']:<25} {b['count']:>5} phones")
    return brands

# ================================================================
# STEP 2: GET ALL PHONE LINKS FOR A BRAND
# ================================================================
def get_phone_links(brand: dict) -> list[str]:
    log.info(f"\n  Getting phone links: {brand['name']} (~{brand['count']} phones)")

    soup = fetch(brand['url'])
    if not soup:
        return []

    pages = [brand['url']]

    # Pagination
    nav = soup.find(class_='nav-pages')
    if nav:
        for a in nav.find_all('a', href=True):
            if a['href'] not in pages:
                pages.append(a['href'])
        log.info(f"    Pagination: {len(pages)} pages")

    links = []
    for i, page_url in enumerate(pages):
        page_soup = soup if i == 0 else fetch(page_url)
        if not page_soup:
            continue

        # Try multiple container selectors
        container = (
            page_soup.find(class_='section-body') or
            page_soup.find(id='phones-list') or
            page_soup.find(class_='makers') or
            page_soup.find('div', class_='section-body')
        )

        if container:
            for a in container.find_all('a', href=True):
                href = a['href']
                if re.search(r'-\d+\.php$', href) and href not in links:
                    links.append(href)
        else:
            # Fallback: scan whole page for phone links
            for a in page_soup.find_all('a', href=True):
                href = a['href']
                if (re.search(r'-\d+\.php$', href)
                        and 'makers' not in href
                        and 'search' not in href
                        and href not in links):
                    links.append(href)

    log.info(f"    ✅ {len(links)} phone links")
    return links

# ================================================================
# STEP 3: SCRAPE ONE PHONE — ALL FEATURES
# ================================================================
def scrape_phone(url: str, brand_name: str) -> dict:
    """
    Extracts EVERY field from a GSMArena phone spec page:

    Standard sections (from #specs-list tables):
      Network, Launch, Body, Display, Platform, Memory,
      Main Camera, Selfie Camera, Sound, Comms, Features,
      Battery, Misc

    Extended sections (from page body):
      Our Tests  → AnTuTu, GeekBench, 3DMark, Display nits,
                   Loudspeaker LUFS, Battery active use
      EU Label   → Energy class, Battery endurance, Cycles,
                   Free fall class, Repairability class
      Pricing    → Per-variant price table (128GB/256GB/etc.)
    """
    soup = fetch(url)
    if not soup:
        return {}

    phone = {
        'Brand':     brand_name,
        'Model_URL': BASE_URL + url if not url.startswith('http') else url,
    }

    # ── Model name ─────────────────────────────────────────────
    for sel in [{'class_': 'specs-phone-name-title'}, {'class_': 'article-info-name'}]:
        tag = soup.find(**sel) if 'class_' in sel else soup.find('h1')
        if tag:
            phone['Model_Name'] = tag.get_text(strip=True)
            break
    if 'Model_Name' not in phone:
        h1 = soup.find('h1')
        phone['Model_Name'] = h1.get_text(strip=True) if h1 else url.replace('.php','')

    log.info(f"      📱 {phone['Model_Name']}")

    # ── Model image ────────────────────────────────────────────
    img_div = soup.find(class_='specs-photo-main')
    if img_div:
        img = img_div.find('img')
        phone['Model_Image'] = img.get('src', '') if img else ''

    # ── MAIN SPEC TABLES from #specs-list ─────────────────────
    specs_div = soup.find(id='specs-list') or soup
    current_section = 'General'
    seen_keys = {}

    for table in specs_div.find_all('table'):
        for row in table.find_all('tr'):

            # Section header row
            th = row.find('th')
            if th:
                current_section = th.get_text(strip=True)
                continue

            tds = row.find_all('td')
            if len(tds) < 2:
                continue

            feat_raw   = tds[0].get_text(strip=True)
            feat_value = tds[1].get_text(separator=' / ', strip=True)
            feat_value = re.sub(r'\s+', ' ', feat_value).strip()

            if not feat_value:
                continue

            # If feature name is blank (IP rating row, UFS row — value-only rows)
            # attach to previous section as a continuation
            if not feat_raw:
                feat_raw = 'Additional'

            key = clean_key(f"{current_section}_{feat_raw}")
            key = dedup_key(key, seen_keys)
            phone[key] = feat_value

    # ── OUR TESTS SECTION ─────────────────────────────────────
    # Appears as a separate div/section below the main spec tables
    # Contains: AnTuTu, GeekBench, 3DMark, Display nits,
    #           Loudspeaker LUFS, Battery active use score

    tests_section = soup.find(class_='specs-test-table')
    if not tests_section:
        # Try alternative: look for div with "Our Tests" heading
        for div in soup.find_all(['div', 'section']):
            heading = div.find(['h2','h3','h4','th'])
            if heading and 'test' in heading.get_text().lower():
                tests_section = div
                break

    if tests_section:
        for row in tests_section.find_all('tr'):
            tds = row.find_all('td')
            if len(tds) >= 2:
                label = tds[0].get_text(strip=True)
                value = tds[1].get_text(separator=' ', strip=True)
                value = re.sub(r'\s+', ' ', value).strip()
                if label and value:
                    key = clean_key(f"Tests_{label}")
                    key = dedup_key(key, seen_keys)
                    phone[key] = value

    # Fallback: search page text for AnTuTu, GeekBench, 3DMark
    page_text = soup.get_text()

    antutu = re.findall(r'AnTuTu[:\s]+([0-9,\s\(\)v\.]+)', page_text)
    if antutu:
        phone['Tests_AnTuTu'] = ' | '.join(a.strip() for a in antutu[:3])

    geek = re.findall(r'GeekBench[:\s]+([0-9,\s\(\)v\.]+)', page_text)
    if geek:
        phone['Tests_GeekBench'] = ' | '.join(g.strip() for g in geek[:3])

    dmark = re.findall(r'3DMark[:\s]+([0-9,\s\(\)A-Za-z\.]+)', page_text)
    if dmark:
        phone['Tests_3DMark'] = ' | '.join(d.strip() for d in dmark[:2])

    nits = re.findall(r'(\d+)\s*nits\s*max\s*brightness', page_text, re.I)
    if nits:
        phone['Tests_Display_Brightness_nits'] = nits[0]

    lufs = re.findall(r'(-[\d.]+)\s*LUFS', page_text)
    if lufs:
        phone['Tests_Loudspeaker_LUFS'] = lufs[0]

    battery_score = re.findall(r'Active use score\s+([\d:]+h)', page_text, re.I)
    if battery_score:
        phone['Tests_Battery_ActiveUse'] = battery_score[0]

    endurance = re.findall(r'(\d+:\d+h)\s*endurance', page_text, re.I)
    if endurance:
        phone['Tests_Battery_Endurance'] = endurance[0]

    cycles = re.findall(r'(\d+)\s*cycles', page_text, re.I)
    if cycles:
        phone['Tests_Battery_Cycles'] = cycles[0]

    # ── EU LABEL SECTION ──────────────────────────────────────
    eu_section = soup.find(class_='eu-label') or soup.find(id='eu-label')
    if eu_section:
        for row in eu_section.find_all('tr'):
            tds = row.find_all('td')
            if len(tds) >= 2:
                label = tds[0].get_text(strip=True)
                value = tds[1].get_text(strip=True)
                if label and value:
                    key = clean_key(f"EU_Label_{label}")
                    key = dedup_key(key, seen_keys)
                    phone[key] = value

    # Fallback: regex for EU label fields
    energy_class = re.findall(r'Energy\s+Class\s+([A-G][+]*)', page_text, re.I)
    if energy_class:
        phone['EU_Label_Energy_Class'] = energy_class[0]

    freefall = re.findall(r'Free fall\s+Class\s+([A-G])', page_text, re.I)
    if freefall:
        phone['EU_Label_Freefall_Class'] = freefall[0]

    repairability = re.findall(r'Repairability\s+Class\s+([A-G])', page_text, re.I)
    if repairability:
        phone['EU_Label_Repairability_Class'] = repairability[0]

    # ── PRICING TABLE ─────────────────────────────────────────
    # Format: "128GB 8GB RAM | $549.99 | €344.00"
    price_table = soup.find(class_='pricing-table') or soup.find(class_='specs-pricing')
    prices_collected = []

    if price_table:
        for row in price_table.find_all('tr'):
            tds = row.find_all('td')
            if tds:
                row_text = ' | '.join(td.get_text(strip=True) for td in tds if td.get_text(strip=True))
                if row_text:
                    prices_collected.append(row_text)
    else:
        # Regex fallback: find storage variant prices
        price_rows = re.findall(
            r'(\d+GB\s+\d+GB\s+RAM)\s+[\$€£₹]\s*([\d,\.]+)',
            page_text
        )
        for variant, price in price_rows:
            prices_collected.append(f"{variant}: {price}")

    if prices_collected:
        phone['Pricing_Variants'] = ' || '.join(prices_collected)

    # General price from Misc section (already captured above)
    # but also try dedicated price div
    price_div = soup.find(class_='price-container')
    if price_div and 'Misc_Price' not in phone:
        phone['Misc_Price'] = price_div.get_text(strip=True)

    # ── CLEAN SHORT COLUMN ALIASES ─────────────────────────────
    # Add short readable names alongside the verbose section|feature keys
    add_shortcuts(phone, seen_keys)

    count = len([k for k in phone if k not in ('Brand','Model_Name','Model_URL','Model_Image')])
    log.info(f"      → {count} fields extracted")
    return phone


# ================================================================
# HELPERS
# ================================================================

def clean_key(raw: str) -> str:
    """Convert raw key to clean snake_case column name."""
    k = re.sub(r'[^a-zA-Z0-9\s_]', '_', raw)
    k = re.sub(r'\s+', '_', k)
    k = re.sub(r'_+', '_', k)
    return k.strip('_')


def dedup_key(key: str, seen: dict) -> str:
    """Append _2, _3 etc. if key already seen."""
    if key not in seen:
        seen[key] = 1
        return key
    seen[key] += 1
    return f"{key}_{seen[key]}"


def add_shortcuts(phone: dict, seen: dict):
    """
    Add short human-readable column aliases for the most important fields.
    Maps "Platform_Chipset" → "Chipset", "Battery_Capacity" → "Battery_mAh" etc.
    """
    SHORTCUT_MAP = {
        'Network_Technology':              'Network_Technology',
        'Network_2G_bands':               '2G_bands',
        'Network_3G_bands':               '3G_bands',
        'Network_4G_bands':               '4G_bands',
        'Network_5G_bands':               '5G_bands',
        'Network_Speed':                  'Network_Speed',
        'Launch_Announced':               'Announced',
        'Launch_Status':                  'Status',
        'Body_Dimensions':                'Dimensions',
        'Body_Weight':                    'Weight',
        'Body_Build':                     'Build_Material',
        'Body_SIM':                       'SIM',
        'Body_IP_rating':                 'IP_Rating',
        'Body_Additional':                'IP_Additional',
        'Display_Type':                   'Display_Type',
        'Display_Size':                   'Display_Size',
        'Display_Resolution':             'Display_Resolution',
        'Display_Protection':             'Display_Protection',
        'Platform_OS':                    'OS',
        'Platform_Chipset':               'Chipset',
        'Platform_CPU':                   'CPU',
        'Platform_GPU':                   'GPU',
        'Memory_Card_slot':               'Card_Slot',
        'Memory_Internal':                'Internal_Memory',
        'Memory_Additional':              'Storage_Standard',   # UFS 3.1 etc.
        'Main_Camera_Features':           'Camera_Features',
        'Main_Camera_Video':              'Camera_Video',
        'Selfie_camera_Video':            'Selfie_Video',
        'Sound_Loudspeaker':              'Loudspeaker',
        'Sound_3_5mm_jack':               'Headphone_Jack',
        'Comms_WLAN':                     'WiFi',
        'Comms_Bluetooth':                'Bluetooth',
        'Comms_Positioning':              'GPS',
        'Comms_NFC':                      'NFC',
        'Comms_Infrared_port':            'Infrared',
        'Comms_Radio':                    'FM_Radio',
        'Comms_USB':                      'USB',
        'Features_Sensors':               'Sensors',
        'Battery_Type':                   'Battery_mAh',
        'Battery_Charging':               'Charging',
        'Misc_Colors':                    'Colors',
        'Misc_Models':                    'Model_Numbers',
        'Misc_SAR':                       'SAR_US',
        'Misc_SAR_EU':                    'SAR_EU',
        'Misc_Price':                     'Price',
        'Tests_Performance':              'Test_AnTuTu_GeekBench',
        'Tests_Display':                  'Test_Display_nits',
        'Tests_Loudspeaker':              'Test_Loudspeaker_LUFS',
        'Tests_Battery':                  'Test_Battery_Score',
    }

    # Camera: handle Triple/Dual/Single/Quad/Penta variants
    for cam_type in ['Triple', 'Dual', 'Single', 'Quad', 'Penta']:
        k = f'Main_Camera_{cam_type}'
        if k in phone and 'Main_Camera_Modules' not in phone:
            phone['Main_Camera_Modules'] = phone[k]
        sk = f'Selfie_camera_{cam_type}'
        if sk in phone and 'Selfie_Camera_Modules' not in phone:
            phone['Selfie_Camera_Modules'] = phone[sk]

    for verbose, short in SHORTCUT_MAP.items():
        if verbose in phone and short not in phone:
            phone[short] = phone[verbose]


# ================================================================
# CSV WRITER — incremental, one row at a time, safe on interruption
# ================================================================
class IncrementalCSV:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.columns  = []
        os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)

    def write_row(self, data: dict):
        new_cols = [k for k in data if k not in self.columns]
        self.columns.extend(new_cols)

        file_exists = os.path.isfile(self.filepath)

        if new_cols and file_exists:
            # New columns discovered — rewrite file with expanded headers
            with open(self.filepath, 'r', encoding='utf-8', newline='') as f:
                rows = list(csv.DictReader(f))
            with open(self.filepath, 'w', encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=self.columns, extrasaction='ignore')
                w.writeheader()
                w.writerows(rows)
                w.writerow(data)
        else:
            mode = 'a' if file_exists else 'w'
            with open(self.filepath, mode, encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=self.columns, extrasaction='ignore')
                if not file_exists:
                    w.writeheader()
                w.writerow(data)


# ================================================================
# MAIN
# ================================================================
def run():
    log.info("\n" + "="*60)
    log.info("GSMArena COMPLETE Scraper")
    log.info("Started: " + datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    log.info("="*60)

    # Connectivity check
    if not check_connection():
        log.error("❌ Cannot reach GSMArena. Run from home Wi-Fi or mobile hotspot.")
        return

    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    # Get all brands
    all_brands = get_all_brands()
    if not all_brands:
        log.error("❌ No brands found.")
        return

    # Filter brands
    if TARGET_BRANDS:
        target_set = {b.lower() for b in TARGET_BRANDS}
        brands = [b for b in all_brands if b['name'].lower() in target_set]
        log.info(f"\nTargeting {len(brands)} specific brands:")
        for b in brands:
            log.info(f"  ✅ {b['name']} ({b['count']} phones)")
        # Warn about not-found brands
        found = {b['name'].lower() for b in brands}
        for t in TARGET_BRANDS:
            if t.lower() not in found:
                log.warning(f"  ⚠️  '{t}' not matched — check spelling")
                log.warning(f"     Available brands: {[b['name'] for b in all_brands]}")
    else:
        brands = all_brands
        total_phones = sum(int(b['count']) for b in brands if b['count'].isdigit())
        log.info(f"\nScraping ALL {len(brands)} brands (~{total_phones:,} phones total)")
        log.info("Estimated time: 40–80 hours depending on delay settings")

    if not brands:
        log.error("❌ No brands to scrape. Exiting.")
        return

    # Master CSV
    master = IncrementalCSV(os.path.join(OUTPUT_FOLDER, MASTER_CSV))
    already_done = set(os.listdir(OUTPUT_FOLDER))
    grand_total  = 0

    for b_idx, brand in enumerate(brands, 1):
        safe_name  = re.sub(r'[^a-zA-Z0-9]', '_', brand['name'])
        brand_file = f"{safe_name}_2025.csv"

        if brand_file in already_done:
            log.info(f"\n[{b_idx}/{len(brands)}] SKIP {brand['name']} (already done)")
            continue

        log.info(f"\n{'='*60}")
        log.info(f"[{b_idx}/{len(brands)}] {brand['name']}  ({brand['count']} phones)")
        log.info(f"{'='*60}")

        phone_links = get_phone_links(brand)
        if not phone_links:
            log.warning(f"  ⚠️  No links found for {brand['name']}")
            continue

        brand_csv   = IncrementalCSV(os.path.join(OUTPUT_FOLDER, brand_file))
        brand_count = 0

        for p_idx, link in enumerate(phone_links, 1):
            log.info(f"\n  [{p_idx}/{len(phone_links)}]")
            data = scrape_phone(link, brand['name'])

            if not data:
                log.warning(f"    ⚠️  Empty result for {link}")
                continue

            brand_csv.write_row(data)
            master.write_row(data)
            brand_count += 1
            grand_total += 1

            log.info(f"    💾 Saved [{brand_count}/{len(phone_links)}]: {data.get('Model_Name','?')}")

        log.info(f"\n  ✅ {brand['name']} complete — {brand_count} phones")

    log.info("\n" + "="*60)
    log.info(f"🎉 COMPLETE — {grand_total} phones scraped across {len(brands)} brands")
    log.info(f"📁 Folder : ./{OUTPUT_FOLDER}/")
    log.info(f"📄 Master : ./{OUTPUT_FOLDER}/{MASTER_CSV}")
    log.info(f"📝 Log    : ./{LOG_FILE}")
    log.info("Finished: " + datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    log.info("="*60)


if __name__ == '__main__':
    run()