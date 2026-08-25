// Read user email for the target UUID so we can log in via HTTP.
import { prisma } from "../src/config/prisma.mjs";
const userId = process.env.TARGET_USER_ID;
const u = await prisma.users.findUnique({
  where: { userId },
  select: { userId: true, email: true, name: true, role: true, isVerified: true, isActive: true },
});
console.log("USER", JSON.stringify(u, null, 2));
await prisma.$disconnect();