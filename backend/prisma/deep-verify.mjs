// prisma/deep-verify.mjs
import { prisma } from "../src/config/prisma.mjs";

async function deepVerify() {
  console.log("🔬 DEEP VERIFICATION\n");
  console.log("=".repeat(60));

  // 1. Phones per brand (top 10)
  const brandStats = await prisma.phones.groupBy({
    by: ['brandId'],
    _count: { brandId: true },
    orderBy: { _count: { brandId: 'desc' } },
    take: 10
  });

  console.log("\n🏢 TOP 10 BRANDS BY PHONE COUNT:");
  for (const stat of brandStats) {
    const brand = await prisma.brands.findUnique({
      where: { brandId: stat.brandId },
      select: { name: true }
    });
    console.log(`   ${brand?.name || 'Unknown'}: ${stat._count.brandId} phones`);
  }

  // 2. OS Distribution
  const osDistribution = await prisma.phoneSpecs.groupBy({
    by: ['os'],
    _count: { os: true },
    orderBy: { _count: { os: 'desc' } },
    take: 15
  });
  
  console.log("\n🤖 TOP 15 OS VERSIONS:");
  osDistribution.forEach(os => {
    console.log(`   ${os.os || 'Unknown'}: ${os._count.os} phones`);
  });

  // 3. Storage Type Distribution (top 10)
  const storageTypes = await prisma.phoneVariants.groupBy({
    by: ['storageType'],
    _count: { storageType: true },
    orderBy: { _count: { storageType: 'desc' } },
    take: 10
  });
  
  console.log("\n💾 TOP 10 STORAGE TYPES:");
  storageTypes.forEach(s => {
    console.log(`   ${s.storageType || 'Not specified'}: ${s._count.storageType} variants`);
  });

  // 4. Year distribution
  const yearDistribution = await prisma.$queryRaw`
    SELECT 
      EXTRACT(YEAR FROM announced)::int as year,
      COUNT(*)::int as count
    FROM phone_specs 
    WHERE announced IS NOT NULL
    GROUP BY year 
    ORDER BY year DESC
    LIMIT 15
  `;
  
  console.log("\n📅 PHONES BY YEAR (Last 15 years):");
  yearDistribution.forEach(y => {
    const bar = '█'.repeat(Math.round(y.count / 20));
    console.log(`   ${y.year}: ${String(y.count).padStart(4)} ${bar}`);
  });

  // 5. Battery capacity distribution (FIXED QUERY)
  const batteryRanges = await prisma.$queryRaw`
    SELECT 
      CASE 
        WHEN battery_mah < 2000 THEN 1
        WHEN battery_mah BETWEEN 2000 AND 2999 THEN 2
        WHEN battery_mah BETWEEN 3000 AND 3999 THEN 3
        WHEN battery_mah BETWEEN 4000 AND 4999 THEN 4
        WHEN battery_mah BETWEEN 5000 AND 5999 THEN 5
        WHEN battery_mah >= 6000 THEN 6
        ELSE 7
      END as sort_order,
      CASE 
        WHEN battery_mah < 2000 THEN 'Under 2000mAh'
        WHEN battery_mah BETWEEN 2000 AND 2999 THEN '2000-2999mAh'
        WHEN battery_mah BETWEEN 3000 AND 3999 THEN '3000-3999mAh'
        WHEN battery_mah BETWEEN 4000 AND 4999 THEN '4000-4999mAh'
        WHEN battery_mah BETWEEN 5000 AND 5999 THEN '5000-5999mAh'
        WHEN battery_mah >= 6000 THEN '6000+mAh'
        ELSE 'Unknown'
      END as range_label,
      COUNT(*)::int as count
    FROM phone_specs
    WHERE battery_mah IS NOT NULL
    GROUP BY range_label, sort_order
    ORDER BY sort_order
  `;
  
  console.log("\n🔋 BATTERY CAPACITY DISTRIBUTION:");
  batteryRanges.forEach(b => {
    const bar = '█'.repeat(Math.round(b.count / 50));
    console.log(`   ${b.range_label.padEnd(20)}: ${String(b.count).padStart(4)} ${bar}`);
  });

  // 6. Camera Statistics
  const cameraStats = await prisma.phoneSpecs.aggregate({
    _avg: { lensCount: true },
    _max: { lensCount: true },
    _min: { lensCount: true },
    where: { lensCount: { not: null } }
  });
  
  console.log("\n📸 CAMERA STATISTICS:");
  console.log(`   Average lens count: ${Number(cameraStats._avg.lensCount).toFixed(1)}`);
  console.log(`   Minimum lens count: ${cameraStats._min.lensCount}`);
  console.log(`   Maximum lens count: ${cameraStats._max.lensCount}`);

  // 7. Refresh Rate Distribution
  const refreshRates = await prisma.phoneSpecs.groupBy({
    by: ['refreshRate'],
    _count: { refreshRate: true },
    where: { refreshRate: { not: null } },
    orderBy: { refreshRate: 'asc' }
  });
  
  console.log("\n📱 REFRESH RATES:");
  refreshRates.forEach(r => {
    console.log(`   ${r.refreshRate}Hz: ${r._count.refreshRate} phones`);
  });

  // 8. Feature Adoption Rates
  const totalWithSpecs = await prisma.phoneSpecs.count();
  const with5G = await prisma.phoneSpecs.count({ where: { supports5g: true } });
  const withNFC = await prisma.phoneSpecs.count({ where: { supportsNfc: true } });
  const withOIS = await prisma.phoneSpecs.count({ where: { ois: true } });
  const withHeadphoneJack = await prisma.phoneSpecs.count({ where: { headphoneJack: true } });
  const withWirelessCharging = await prisma.phoneSpecs.count({ 
    where: { reverseWireless: true } 
  });
  
  console.log("\n📡 FEATURE ADOPTION RATES:");
  console.log(`   5G Support:        ${with5G} (${((with5G/totalWithSpecs)*100).toFixed(1)}%)`);
  console.log(`   NFC:               ${withNFC} (${((withNFC/totalWithSpecs)*100).toFixed(1)}%)`);
  console.log(`   OIS (Camera):      ${withOIS} (${((withOIS/totalWithSpecs)*100).toFixed(1)}%)`);
  console.log(`   Headphone Jack:    ${withHeadphoneJack} (${((withHeadphoneJack/totalWithSpecs)*100).toFixed(1)}%)`);
  console.log(`   Reverse Wireless:  ${withWirelessCharging} (${((withWirelessCharging/totalWithSpecs)*100).toFixed(1)}%)`);

  // 9. Charging speed distribution (FIXED QUERY)
  const chargingRanges = await prisma.$queryRaw`
    SELECT 
      CASE 
        WHEN wired_charging_w IS NULL THEN 1
        WHEN wired_charging_w < 10 THEN 2
        WHEN wired_charging_w BETWEEN 10 AND 19 THEN 3
        WHEN wired_charging_w BETWEEN 20 AND 29 THEN 4
        WHEN wired_charging_w BETWEEN 30 AND 49 THEN 5
        WHEN wired_charging_w BETWEEN 50 AND 99 THEN 6
        WHEN wired_charging_w >= 100 THEN 7
      END as sort_order,
      CASE 
        WHEN wired_charging_w IS NULL THEN 'Unknown'
        WHEN wired_charging_w < 10 THEN 'Under 10W'
        WHEN wired_charging_w BETWEEN 10 AND 19 THEN '10-19W'
        WHEN wired_charging_w BETWEEN 20 AND 29 THEN '20-29W'
        WHEN wired_charging_w BETWEEN 30 AND 49 THEN '30-49W'
        WHEN wired_charging_w BETWEEN 50 AND 99 THEN '50-99W'
        WHEN wired_charging_w >= 100 THEN '100W+'
      END as range_label,
      COUNT(*)::int as count
    FROM phone_specs
    GROUP BY range_label, sort_order
    ORDER BY sort_order
  `;
  
  console.log("\n⚡ CHARGING SPEED DISTRIBUTION:");
  chargingRanges.forEach(c => {
    const bar = '█'.repeat(Math.round(c.count / 30));
    console.log(`   ${c.range_label.padEnd(15)}: ${String(c.count).padStart(4)} ${bar}`);
  });

  // 10. RAM Distribution (Top 10)
  const ramDistribution = await prisma.phoneVariants.groupBy({
    by: ['ramGb'],
    _count: { ramGb: true },
    orderBy: { ramGb: 'asc' },
    take: 15
  });
  
  console.log("\n💾 TOP RAM CONFIGURATIONS:");
  ramDistribution.forEach(r => {
    const bar = '█'.repeat(Math.round(r._count.ramGb / 30));
    console.log(`   ${String(r.ramGb).padStart(2)}GB RAM: ${String(r._count.ramGb).padStart(5)} ${bar}`);
  });

  // 11. Price Range Statistics
  const priceStats = await prisma.phoneVariants.aggregate({
    _min: { price: true },
    _max: { price: true },
    _avg: { price: true },
    _count: true
  });
  
  console.log("\n💰 PRICE STATISTICS:");
  console.log(`   Total variants with price: ${priceStats._count}`);
  console.log(`   Minimum price: €${Number(priceStats._min.price).toFixed(2)}`);
  console.log(`   Maximum price: €${Number(priceStats._max.price).toFixed(2)}`);
  console.log(`   Average price: €${Number(priceStats._avg.price).toFixed(2)}`);

  // 12. Display Size Statistics
  const displayStats = await prisma.phoneSpecs.aggregate({
    _avg: { displaySize: true },
    _min: { displaySize: true },
    _max: { displaySize: true },
    where: { displaySize: { not: null } }
  });
  
  console.log("\n📏 DISPLAY SIZE STATISTICS:");
  console.log(`   Smallest: ${Number(displayStats._min.displaySize).toFixed(2)}"`);
  console.log(`   Largest:  ${Number(displayStats._max.displaySize).toFixed(2)}"`);
  console.log(`   Average:  ${Number(displayStats._avg.displaySize).toFixed(2)}"`);

  // 13. Top chipsets
  const topChipsets = await prisma.phoneSpecs.groupBy({
    by: ['chipset'],
    _count: { chipset: true },
    orderBy: { _count: { chipset: 'desc' } },
    take: 10,
    where: { chipset: { not: null } }
  });
  
  console.log("\n🔧 TOP 10 CHIPSETS:");
  topChipsets.forEach(c => {
    console.log(`   ${c.chipset}: ${c._count.chipset} phones`);
  });

  // 14. SIM Type Distribution
  const simTypes = await prisma.phoneSpecs.groupBy({
    by: ['simType'],
    _count: { simType: true },
    orderBy: { _count: { simType: 'desc' } },
    take: 5,
    where: { simType: { not: null } }
  });
  
  console.log("\n📞 TOP SIM TYPES:");
  simTypes.forEach(s => {
    console.log(`   ${s.simType}: ${s._count.simType} phones`);
  });

  console.log("\n" + "=".repeat(60));
  console.log("✅ DEEP VERIFICATION COMPLETE");
  
  // Summary
  console.log("\n📊 QUICK SUMMARY:");
  console.log(`   Total Phones: ${await prisma.phones.count()}`);
  console.log(`   Total Variants: ${await prisma.phoneVariants.count()}`);
  console.log(`   Total Brands: ${await prisma.brands.count()}`);
  console.log(`   Date Range: ${yearDistribution[yearDistribution.length-1]?.year} - ${yearDistribution[0]?.year}`);
}

deepVerify()
  .catch(console.error)
  .finally(() => prisma.$disconnect());