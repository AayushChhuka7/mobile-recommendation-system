/**
 * Optimized bulk import script for GSMArena data
 * Uses batch processing and connection pooling for better performance
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import { prisma } from "../src/config/prisma.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CSV = path.resolve(__dirname, "..", "..", "dataset", "GSMArena_Cleaned_Dataset.csv");
const CSV_PATH = process.argv[2] || DEFAULT_CSV;

// Configuration
const BATCH_SIZE = 100;
const LOG_INTERVAL = 500;

const SOURCE_TAG = "gsmarena_csv";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStringOrNull(v, maxLen) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function toDecimalStringOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function toBoolFromYesNo(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "yes") return true;
  if (s === "no") return false;
  return null;
}

function toDateOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return null;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(`${yearMatch[0]}-01-01`);
}

// Convert CSV sensor string to JSON array
function toSensorsArray(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "unspecified" || s.toLowerCase() === "no") {
    return null;
  }
  return s.split(',').map(sensor => sensor.trim()).filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// Batch Processing Functions
// ---------------------------------------------------------------------------

async function importBrands(uniqueBrands) {
  console.log(`Upserting ${uniqueBrands.size} unique brands...`);
  
  const brandInserts = Array.from(uniqueBrands).map(name => ({
    name
  }));

  for (let i = 0; i < brandInserts.length; i += BATCH_SIZE) {
    const chunk = brandInserts.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      chunk.map(brand =>
        prisma.brands.upsert({
          where: { name: brand.name },
          update: {},
          create: brand
        })
      )
    );
  }
  
  console.log("Brands imported successfully");
}

async function importPhonesBatch(phoneRows) {
  const operations = [];
  const phoneMap = new Map();
  
  for (const row of phoneRows) {
    const key = `${row.brandId}_${row.modelName}`;
    if (!phoneMap.has(key)) {
      phoneMap.set(key, row);
    }
  }
  
  for (const [key, row] of phoneMap) {
    operations.push(
      prisma.phones.upsert({
        where: {
          brandId_modelName: {
            brandId: row.brandId,
            modelName: row.modelName
          }
        },
        update: {
          imageUrl: row.imageUrl,
          source: row.source,
          sourceUrl: row.sourceUrl,
          antutuScore: row.antutuScore
        },
        create: {
          brandId: row.brandId,
          modelName: row.modelName,
          imageUrl: row.imageUrl,
          source: row.source,
          sourceUrl: row.sourceUrl,
          antutuScore: row.antutuScore,
          isActive: true
        }
      })
    );
  }
  
  return prisma.$transaction(operations);
}

async function importSpecsBatch(specRows) {
  const operations = specRows.map(row => 
    prisma.phoneSpecs.upsert({
      where: { phoneId: row.phoneId },
      update: row.specs,
      create: {
        phoneId: row.phoneId,
        ...row.specs
      }
    })
  );
  
  return prisma.$transaction(operations);
}

async function importVariantsBatch(variantRows) {
  const operations = variantRows.map(row =>
    prisma.phoneVariants.upsert({
      where: {
        phoneId_ramGb_storageGb: {
          phoneId: row.phoneId,
          ramGb: row.ramGb,
          storageGb: row.storageGb
        }
      },
      update: {
        price: row.price,
        storageType: row.storageType,
        isAvailable: true
      },
      create: {
        phoneId: row.phoneId,
        ramGb: row.ramGb,
        storageGb: row.storageGb,
        price: row.price,
        storageType: row.storageType,
        isAvailable: true
      }
    })
  );
  
  return prisma.$transaction(operations);
}

// ---------------------------------------------------------------------------
// Main Import Orchestrator
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV not found at ${CSV_PATH}`);
  }

  const raw = fs.readFileSync(CSV_PATH, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`Loaded ${rows.length} rows from ${CSV_PATH}.`);

  const startTime = Date.now();
  let totalVariants = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  // PHASE 1: Collect all unique brands and insert them
  const uniqueBrands = new Set();
  const validRows = [];

  for (const row of rows) {
    const brandName = toStringOrNull(row.Brand);
    const modelName = toStringOrNull(row.Model_Name);
    const ramGb = toIntOrNull(row.RAM_GB);
    const storageGb = toIntOrNull(row.Storage_GB);

    if (!brandName || !modelName) {
      totalSkipped++;
      continue;
    }

    if (ramGb === null || storageGb === null) {
      totalSkipped++;
      console.warn(`Skipping ${brandName}/${modelName} - missing RAM/Storage`);
      continue;
    }

    uniqueBrands.add(brandName);
    validRows.push({ ...row, brandName, modelName, ramGb, storageGb });
  }

  await importBrands(uniqueBrands);

  // PHASE 2: Create a brand lookup cache
  console.log("Building brand cache...");
  const allBrands = await prisma.brands.findMany();
  const brandCache = new Map(allBrands.map(b => [b.name, b.brandId]));

  // PHASE 3: Process in batches
  console.log(`Processing ${validRows.length} valid rows in batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const batch = validRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(validRows.length / BATCH_SIZE);

    try {
      // Prepare phone data
      const phoneRows = batch.map(row => ({
        brandId: brandCache.get(row.brandName),
        modelName: row.modelName,
        imageUrl: toStringOrNull(row.Model_Image, 500),
        source: SOURCE_TAG,
        sourceUrl: toStringOrNull(row.Model_URL, 500),
        antutuScore: toIntOrNull(row.AnTuTu_Score)
      }));

      // Import phones
      const phoneResults = await importPhonesBatch(phoneRows);
      
      // Create phone lookup
      const phoneMap = new Map();
      for (const phone of phoneResults) {
        phoneMap.set(`${phone.brandId}_${phone.modelName}`, phone.phoneId);
      }

      // Prepare specs and variants with CORRECT field names
      const specRows = [];
      const variantRows = [];

      for (const row of batch) {
        const phoneId = phoneMap.get(`${brandCache.get(row.brandName)}_${row.modelName}`);
        if (!phoneId) {
          console.error(`Failed to find phone for ${row.brandName}/${row.modelName}`);
          totalFailed++;
          continue;
        }

        // Prepare specs data with CORRECT Prisma field names
        specRows.push({
          phoneId,
          specs: {
            // Network & Connectivity - using schema field names
            networkTech: toStringOrNull(row.Network_Technology, 100),
            supports5g: toBoolFromYesNo(row["5G_Support"]) ?? false,
            supportsNfc: toBoolFromYesNo(row.NFC) ?? false,
            dualSim: /dual/i.test(String(row.SIM_Type || "")),
            simType: toStringOrNull(row.SIM_Type, 50),
            wifi: toStringOrNull(row.WiFi, 100),
            bluetooth: toStringOrNull(row.Bluetooth_Version, 20), // schema has 'bluetooth' not 'bluetoothVersion'
            usbType: toStringOrNull(row.USB_Type, 50),
            headphoneJack: toBoolFromYesNo(row.Headphone_Jack),
            gps: toBoolFromYesNo(row.GPS) ?? true,
            sensors: toSensorsArray(row.Sensors),

            // Display - using schema field names
            displayType: toStringOrNull(row.Display_Type, 50),
            refreshRate: toIntOrNull(row.Refresh_Rate_Hz), // schema has 'refreshRate' not 'refreshRateHz'
            displaySize: toDecimalStringOrNull(row.Display_Size_inch), // schema has 'displaySize' not 'displaySizeInch'
            resolution: toStringOrNull(row.Resolution, 30),
            ppiDensity: toIntOrNull(row.PPI_Density),
            screenToBody: toDecimalStringOrNull(row.Screen_to_Body_Pct), // schema has 'screenToBody' not 'screenToBodyPct'
            displayProtection: toStringOrNull(row.Display_Protection, 100),

            // Platform - using schema field names
            os: toStringOrNull(row.OS, 40),
            chipset: toStringOrNull(row.Chipset, 100),
            processNode: toStringOrNull(row.Process_Node_nm, 20), // schema has 'processNode' not 'processNodeNm'
            cpu: toStringOrNull(row.CPU, 200),
            gpu: toStringOrNull(row.GPU, 200),

            // Camera - using schema field names
            mainCamera: toStringOrNull(row.Main_Camera_MP, 50), // schema has 'mainCamera' not 'mainCameraMp'
            lensCount: toIntOrNull(row.Lens_Count),
            mainAperture: toStringOrNull(row.Main_Aperture, 20),
            ois: toBoolFromYesNo(row.OIS) ?? false,
            sensorSize: toStringOrNull(row.Sensor_Size, 50),
            camera4K: toBoolFromYesNo(row.Camera_4K_Video), // schema has 'camera4K' not 'camera4kVideo'
            cameraVideo: toStringOrNull(row.Camera_Video, 200),
            selfieCamera: toStringOrNull(row.Selfie_Camera_MP, 50), // schema has 'selfieCamera' not 'selfieCameraMp'
            selfie4K: toBoolFromYesNo(row.Selfie_4K_Video), // schema has 'selfie4K' not 'selfie4kVideo'

            // Physical
            dimensions: toStringOrNull(row.Dimensions, 100),
            weight: toDecimalStringOrNull(row.Weight_g),

            // Battery - using schema field names
            batteryMah: toIntOrNull(row.Battery_mAh),
            wiredCharging: toIntOrNull(row.Wired_Charging_W), // schema has 'wiredCharging' not 'wiredChargingW'
            reverseWireless: toBoolFromYesNo(row.Reverse_Wireless_Charging), // schema has 'reverseWireless' not 'reverseWirelessCharging'

            // Metadata
            announced: toDateOrNull(row.Announced),
            status: toStringOrNull(row.Status, 50)
          }
        });

        // Prepare variant data
        variantRows.push({
          phoneId,
          ramGb: row.ramGb,
          storageGb: row.storageGb,
          price: toDecimalStringOrNull(row.Price_EUR),
          storageType: toStringOrNull(row.Storage_Type, 20)
        });
      }

      // Import specs and variants in parallel
      await Promise.all([
        importSpecsBatch(specRows),
        importVariantsBatch(variantRows)
      ]);

      totalVariants += variantRows.length;

      // Log progress every 10 batches or at the end
      if (batchNum % 10 === 0 || i + BATCH_SIZE >= validRows.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const progress = Math.min(i + BATCH_SIZE, validRows.length);
        const pct = ((progress / validRows.length) * 100).toFixed(1);
        console.log(
          `Batch ${batchNum}/${totalBatches} | ` +
          `Progress: ${progress}/${validRows.length} (${pct}%) | ` +
          `Variants: ${totalVariants} | ` +
          `Elapsed: ${elapsed}s`
        );
      }

    } catch (err) {
      totalFailed += batch.length;
      console.error(`Batch ${batchNum} failed:`, err.message);
    }
  }

  // Final Summary
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log("IMPORT COMPLETED");
  console.log("=".repeat(60));
  console.log(`Total rows in CSV:        ${rows.length}`);
  console.log(`Valid rows processed:     ${validRows.length}`);
  console.log(`Variants created:         ${totalVariants}`);
  console.log(`Skipped (invalid data):   ${totalSkipped}`);
  console.log(`Failed (errors):          ${totalFailed}`);
  console.log(`Total time:               ${totalTime}s`);
  console.log("=".repeat(60));
}

// Execute
main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });