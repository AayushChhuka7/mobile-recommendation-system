import { PrismaClient } from "../generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import "dotenv/config";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// console.log(process.env.DATABASE_URL);

export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});
