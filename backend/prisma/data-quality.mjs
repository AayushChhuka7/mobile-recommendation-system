// prisma/data-quality.mjs
import { prisma } from "../src/config/prisma.mjs";

async function dataQualityCheck() {
  console.log("🔍 DATA QUALITY REPORT\n");

  // Check for phones with missing specs (this is possible since specs is optional 1-to-1)
  const withoutSpecs = await prisma.phones.count({
    where: { specs: null },
  });
  console.log(`✅ Phones without specs: ${withoutSpecs} (should be 0)`);

  // Check for unrealistic prices
  const unrealisticLow = await prisma.phoneVariants.count({
    where: { price: { lt: 10 } },
  });
  const unrealisticHigh = await prisma.phoneVariants.count({
    where: { price: { gt: 10000 } },
  });
  console.log(`💰 Variants with price <€10: ${unrealisticLow}`);
  console.log(`💰 Variants with price >€10000: ${unrealisticHigh}`);

  // Check for 0GB RAM (suspicious)
  const zeroRam = await prisma.phoneVariants.count({
    where: { ramGb: 0 },
  });
  console.log(`⚠️  Variants with 0GB RAM: ${zeroRam}`);

  // Check for variants without storage type
  const withoutStorageType = await prisma.phoneVariants.count({
    where: { storageType: null },
  });
  console.log(`📦 Variants without storage type: ${withoutStorageType}`);

  // Phones without any variants
  const phonesWithoutVariants = await prisma.$queryRaw`
    SELECT COUNT(*) as count
    FROM phones p
    LEFT JOIN phone_variants v ON p.phone_id = v.phone_id
    WHERE v.variant_id IS NULL
  `;
  console.log(
    `❌ Phones without any variants: ${phonesWithoutVariants[0].count} (should be 0)`,
  );

  // Phones without announced date
  const withoutDate = await prisma.phoneSpecs.count({
    where: { announced: null },
  });
  console.log(`📅 Phones without announced date: ${withoutDate}`);

  // Date range check
  const oldestPhone = await prisma.phoneSpecs.findFirst({
    where: { announced: { not: null } },
    orderBy: { announced: "asc" },
    select: {
      announced: true,
      phone: {
        select: {
          modelName: true,
          brand: { select: { name: true } },
        },
      },
    },
  });

  if (oldestPhone) {
    console.log(
      `📅 Oldest phone: ${oldestPhone.phone.brand.name} ${oldestPhone.phone.modelName} (${oldestPhone.announced?.getFullYear()})`,
    );
  }

  const newestPhone = await prisma.phoneSpecs.findFirst({
    where: { announced: { not: null } },
    orderBy: { announced: "desc" },
    select: {
      announced: true,
      phone: {
        select: {
          modelName: true,
          brand: { select: { name: true } },
        },
      },
    },
  });

  if (newestPhone) {
    console.log(
      `📅 Newest phone: ${newestPhone.phone.brand.name} ${newestPhone.phone.modelName} (${newestPhone.announced?.getFullYear()})`,
    );
  }

  // Source verification
  const sourceDistribution = await prisma.phones.groupBy({
    by: ["source"],
    _count: { source: true },
  });

  console.log("\n📊 DATA SOURCES:");
  sourceDistribution.forEach((s) => {
    console.log(`   ${s.source || "Unknown"}: ${s._count.source} phones`);
  });

  // Check for phones with empty model names
  const emptyModelNames = await prisma.phones.count({
    where: { modelName: "" },
  });
  console.log(
    `\n❌ Phones with empty model names: ${emptyModelNames} (should be 0)`,
  );

  // Check display size anomalies
  const tinyDisplays = await prisma.phoneSpecs.count({
    where: {
      displaySize: { lt: 1 },
    },
  });
  const hugeDisplays = await prisma.phoneSpecs.count({
    where: {
      displaySize: { gt: 10 },
    },
  });
  console.log(`📱 Tiny displays (<1 inch): ${tinyDisplays}`);
  console.log(`📱 Huge displays (>10 inches): ${hugeDisplays}`);

  console.log("\n✅ DATA QUALITY CHECK COMPLETE");
}

dataQualityCheck()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
