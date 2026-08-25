// List active phones so we can pick one to compare iPhone 17 against.
import { prisma } from "../src/config/prisma.mjs";
const phones = await prisma.phones.findMany({
  where: { isActive: true },
  select: { phoneId: true, modelName: true, brand: { select: { name: true } } },
  take: 20,
});
for (const p of phones) {
  console.log(`${p.phoneId}\t${p.brand?.name}\t${p.modelName}`);
}
await prisma.$disconnect();