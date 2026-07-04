import "dotenv/config";
import { PrismaClient } from "./src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { hashPassword } from "./src/utils/crypto.mjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

try {
  const adminRole = await prisma.roles.findUnique({ where: { roleName: "Admin" } });
  const customerRole = await prisma.roles.findUnique({ where: { roleName: "Customer" } });

  const adminHash = await hashPassword("AdminPass123!");
  const customerHash = await hashPassword("CustomerPass123!");

  await prisma.users.deleteMany({
    where: { email: { in: ["smoketest-admin@example.com", "smoketest-customer@example.com"] } },
  });

  const admin = await prisma.users.create({
    data: {
      name: "Smoke Admin",
      email: "smoketest-admin@example.com",
      password: adminHash,
      isVerified: true,
      roleId: adminRole.roleId,
    },
  });
  console.log("admin:", admin.email, admin.userId);

  const customer = await prisma.users.create({
    data: {
      name: "Smoke Customer",
      email: "smoketest-customer@example.com",
      password: customerHash,
      isVerified: true,
      roleId: customerRole.roleId,
    },
  });
  console.log("customer:", customer.email, customer.userId);
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
