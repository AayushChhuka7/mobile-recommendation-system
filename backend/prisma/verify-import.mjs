import { prisma } from "../src/config/prisma.mjs";

async function verifyImport() {
  console.log("=".repeat(60));
  console.log("DATABASE VERIFICATION");
  console.log("=".repeat(60));

  // Brand counts
  const brandCount = await prisma.brands.count();
  console.log(`\n📊 BRANDS: ${brandCount}`);

  // Phone counts
  const phoneCount = await prisma.phones.count();
  const activePhones = await prisma.phones.count({ where: { isActive: true } });
  const phonesWithImage = await prisma.phones.count({
    where: { imageUrl: { not: null } },
  });
  console.log(`📱 PHONES:`);
  console.log(`   Total: ${phoneCount}`);
  console.log(`   Active: ${activePhones}`);
  console.log(`   With images: ${phonesWithImage}`);

  // Variant counts
  const variantCount = await prisma.phoneVariants.count();
  const availableVariants = await prisma.phoneVariants.count({
    where: { isAvailable: true },
  });
  console.log(`💾 VARIANTS:`);
  console.log(`   Total: ${variantCount}`);
  console.log(`   Available: ${availableVariants}`);

  // Specs counts
  const specsCount = await prisma.phoneSpecs.count();
  const phonesWith5G = await prisma.phoneSpecs.count({
    where: { supports5g: true },
  });
  const phonesWithNFC = await prisma.phoneSpecs.count({
    where: { supportsNfc: true },
  });
  console.log(`📋 SPECIFICATIONS:`);
  console.log(`   Total specs records: ${specsCount}`);
  console.log(`   5G phones: ${phonesWith5G}`);
  console.log(`   NFC phones: ${phonesWithNFC}`);

  // Sample data
  console.log("\n📱 SAMPLE DATA:");

  // Top brands
  const topBrands = await prisma.brands.findMany({
    include: {
      _count: {
        select: { phones: true },
      },
    },
    orderBy: {
      phones: { _count: "desc" },
    },
    take: 5,
  });

  console.log("\n🏢 TOP 5 BRANDS:");
  topBrands.forEach((brand) => {
    console.log(`   ${brand.name}: ${brand._count.phones} phones`);
  });

  // Sample phone with variants and specs
  const samplePhone = await prisma.phones.findFirst({
    where: {
      variants: { some: {} },
      specs: { isNot: null },
    },
    include: {
      brand: true,
      variants: { take: 3 },
      specs: true,
    },
  });

  if (samplePhone) {
    console.log("\n📞 SAMPLE PHONE:");
    console.log(`   Brand: ${samplePhone.brand.name}`);
    console.log(`   Model: ${samplePhone.modelName}`);
    console.log(`   Source: ${samplePhone.source}`);
    console.log(`   Active: ${samplePhone.isActive}`);
    console.log(`   Variants: ${samplePhone.variants.length} shown`);

    samplePhone.variants.forEach((v) => {
      console.log(
        `     - ${v.ramGb}GB RAM / ${v.storageGb}GB Storage / €${v.price}`,
      );
    });

    if (samplePhone.specs) {
      console.log(`   OS: ${samplePhone.specs.os}`);
      console.log(
        `   Display: ${samplePhone.specs.displayType} ${samplePhone.specs.displaySize}"`,
      );
      console.log(`   5G: ${samplePhone.specs.supports5g}`);
      console.log(`   Battery: ${samplePhone.specs.batteryMah}mAh`);
    }
  }

  // Price ranges
  const priceStats = await prisma.phoneVariants.aggregate({
    _min: { price: true },
    _max: { price: true },
    _avg: { price: true },
  });

  console.log("\n💰 PRICE STATISTICS:");
  console.log(`   Min: €${priceStats._min.price}`);
  console.log(`   Max: €${priceStats._max.price}`);
  console.log(`   Avg: €${Number(priceStats._avg.price).toFixed(2)}`);

  // RAM/Storage distribution
  const ramDistribution = await prisma.phoneVariants.groupBy({
    by: ["ramGb"],
    _count: { ramGb: true },
    orderBy: { ramGb: "asc" },
  });

  console.log("\n💾 RAM DISTRIBUTION:");
  ramDistribution.forEach((r) => {
    console.log(`   ${r.ramGb}GB: ${r._count.ramGb} variants`);
  });

  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION COMPLETE");
  console.log("=".repeat(60));
}

verifyImport()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
