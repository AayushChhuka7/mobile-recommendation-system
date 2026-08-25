// Today's writes + iPhone 17 affinity investigation
import { prisma } from "../src/config/prisma.mjs";

const userId = process.env.TARGET_USER_ID;

// All rows updated today
const todayRows = await prisma.behaviorScore.findMany({
  where: {
    userId,
    updatedAt: { gte: new Date("2026-08-25T00:00:00Z") },
  },
  orderBy: { updatedAt: "desc" },
  select: { tag: true, score: true, updatedAt: true },
});
console.log("---TODAYS_WRITES_2026_08_25---");
console.log("COUNT", todayRows.length);
for (const r of todayRows) {
  console.log(`${r.updatedAt.toISOString()}\t${r.tag}\t${r.score}`);
}

// All affinity rows for iPhone 17 phoneId
console.log("---AFFINITY_FOR_IPHONE17_UUID_1fd8a75f---");
const iPhone17Aff = await prisma.behaviorScore.findMany({
  where: { userId, tag: { startsWith: "affinity:" } },
  orderBy: { score: "desc" },
});
for (const r of iPhone17Aff) {
  const id = r.tag.slice("affinity:".length);
  if (id === "1fd8a75f-f7ef-4203-a212-ccc5b3238897") {
    console.log(JSON.stringify(r, null, 2));
  }
}

// Event log for today's compares
const events = await prisma.event.findMany({
  where: { userId, eventType: "compare", createdAt: { gte: new Date("2026-08-25T00:00:00Z") } },
  orderBy: { createdAt: "desc" },
  take: 20,
  select: { eventId: true, createdAt: true, phoneId: true, payload: true },
});
console.log("---TODAYS_COMPARE_EVENTS---");
console.log("COUNT", events.length);
for (const e of events) {
  console.log(`${e.createdAt.toISOString()}\tphone=${e.phoneId}\tpayload=${JSON.stringify(e.payload)}`);
}

// Latest event for this user
const lastEvent = await prisma.event.findFirst({
  where: { userId },
  orderBy: { createdAt: "desc" },
  select: { eventId: true, eventType: true, createdAt: true, phoneId: true },
});
console.log("---LATEST_EVENT_ANY_TYPE---", JSON.stringify(lastEvent, null, 2));

await prisma.$disconnect();