// Per-user diagnostic — show all behaviour rows for a target user
// sorted by tag.
import { prisma } from "../src/config/prisma.mjs";

const userId = "b7e58b7d-8472-4710-87bb-6d6f53bfce66"; // your user

async function main() {
  console.log(`=== BehaviourScore rows for user ${userId} ===`);
  const rows = await prisma.behaviorScore.findMany({
    where: { userId },
    orderBy: [{ tag: "asc" }],
    select: { tag: true, score: true, updatedAt: true },
  });
  for (const r of rows) {
    console.log({
      tag: r.tag,
      score: Number(r.score).toFixed(4),
      updatedAt: r.updatedAt,
    });
  }

  console.log(`\n=== Distinct compare pairs for user ${userId} ===`);
  const pairs = await prisma.$queryRaw`
    SELECT DISTINCT payload->>'pairKey' AS pair_key
    FROM events
    WHERE user_id = ${userId}::uuid
      AND event_type = 'compare'
      AND payload ? 'pairKey'
      AND payload->>'pairKey' IS NOT NULL
  `;
  console.log("count:", pairs.length);
  for (const p of pairs) console.log("  ", p.pair_key);

  console.log(`\n=== Distinct phones touched via compare for user ${userId} ===`);
  const phoneIds = await prisma.event.findMany({
    where: { userId, eventType: "compare", phoneId: { not: null } },
    distinct: ["phoneId"],
    select: { phoneId: true },
  });
  for (const p of phoneIds) console.log("  ", p.phoneId);

  // Map phoneIds to brand via Prisma
  const ids = phoneIds.map((p) => p.phoneId);
  if (ids.length) {
    const phones = await prisma.phones.findMany({
      where: { phoneId: { in: ids } },
      select: { phoneId: true, modelName: true, brand: { select: { name: true } } },
    });
    console.log(`\n=== Phone → brand mapping ===`);
    const brandCounts = {};
    for (const p of phones) {
      const brand = (p.brand && p.brand.name) || "(none)";
      console.log(`  ${p.modelName}  →  brand:${brand}`);
      const key = brand.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
      brandCounts[key] = (brandCounts[key] || 0) + 1;
    }
    console.log(`\n=== brandGate state (distinct phones per brand) ===`);
    for (const [b, n] of Object.entries(brandCounts)) {
      console.log(`  brand:${b}  →  ${n} distinct phone(s)`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("diagnostic failed:", err);
  process.exit(1);
});