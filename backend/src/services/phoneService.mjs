import { prisma } from "../config/prisma.mjs";
import { notFound } from "../utils/ApiError.mjs";
import { buildPaginationMeta } from "../utils/ApiResponse.mjs";

// Build where clause from query parameters
const buildPhoneWhereClause = (queryParams) => {
  const where = { isActive: true };
  const specsWhere = {};
  const variantsWhere = {};

  // Brand filter
  if (queryParams.brand) {
    const brands = queryParams.brand.split(",").map((b) => b.trim());
    where.brand = { name: { in: brands, mode: "insensitive" } };
  }

  // Search by model name
  if (queryParams.search) {
    where.modelName = { contains: queryParams.search, mode: "insensitive" };
  }

  // Price range
  if (queryParams.minPrice || queryParams.maxPrice) {
    const priceFilter = {};
    if (queryParams.minPrice)
      priceFilter.gte = parseFloat(queryParams.minPrice);
    if (queryParams.maxPrice)
      priceFilter.lte = parseFloat(queryParams.maxPrice);
    variantsWhere.price = priceFilter;
  }

  // RAM filter
  if (queryParams.minRam) {
    variantsWhere.ramGb = { gte: parseInt(queryParams.minRam) };
  }

  // Storage filter
  if (queryParams.minStorage) {
    variantsWhere.storageGb = { gte: parseInt(queryParams.minStorage) };
  }

  // Specs filters
  if (queryParams.has5G === "true") specsWhere.supports5g = true;
  if (queryParams.hasNfc === "true") specsWhere.supportsNfc = true;
  if (queryParams.hasOis === "true") specsWhere.ois = true;
  if (queryParams.hasHeadphoneJack === "true") specsWhere.headphoneJack = true;

  // OS filter
  if (queryParams.os) {
    specsWhere.os = { contains: queryParams.os, mode: "insensitive" };
  }

  // Battery filter
  if (queryParams.minBattery) {
    specsWhere.batteryMah = { gte: parseInt(queryParams.minBattery) };
  }

  // Year filter
  if (queryParams.year) {
    const year = parseInt(queryParams.year);
    specsWhere.announced = {
      gte: new Date(`${year}-01-01`),
      lt: new Date(`${year + 1}-01-01`),
    };
  }

  // Apply specs filter
  if (Object.keys(specsWhere).length > 0) {
    where.specs = specsWhere;
  }

  // Apply variants filter
  if (Object.keys(variantsWhere).length > 0) {
    where.variants = { some: variantsWhere };
  }

  return where;
};

// Build sort order
const buildSortOrder = (sortParam) => {
  if (!sortParam) return { createdAt: "desc" };

  const sortMappings = {
    newest: { createdAt: "desc" },
    oldest: { createdAt: "asc" },
    name_asc: { modelName: "asc" },
    name_desc: { modelName: "desc" },
    price_asc: { variants: { _count: "asc" } },
    price_desc: { variants: { _count: "desc" } },
    antutu: { antutuScore: "desc" },
    popular: { antutuScore: "desc" },
  };

  return sortMappings[sortParam] || { createdAt: "desc" };
};

export const getAllPhones = async (queryParams) => {
  const page = parseInt(queryParams.page) || 1;
  const limit = Math.min(parseInt(queryParams.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const where = buildPhoneWhereClause(queryParams);
  const orderBy = buildSortOrder(queryParams.sort);

  const [phones, total] = await Promise.all([
    prisma.phones.findMany({
      where,
      include: {
        brand: {
          select: { brandId: true, name: true, logoUrl: true },
        },
        specs: {
          select: {
            os: true,
            chipset: true,
            displaySize: true,
            displayType: true,
            refreshRate: true,
            mainCamera: true,
            batteryMah: true,
            supports5g: true,
            supportsNfc: true,
          },
        },
        variants: {
          where: { isAvailable: true },
          orderBy: { price: "asc" },
          select: {
            variantId: true,
            ramGb: true,
            storageGb: true,
            price: true,
            storageType: true,
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.phones.count({ where }),
  ]);

  const pagination = buildPaginationMeta({ page, limit, total });

  return { phones, pagination };
};

export const getPhoneById = async (phoneId) => {
  const phone = await prisma.phones.findUnique({
    where: { phoneId },
    include: {
      brand: true,
      specs: true,
      variants: {
        where: { isAvailable: true },
        orderBy: { price: "asc" },
      },
    },
  });

  if (!phone) {
    throw notFound("Phone not found");
  }

  return phone;
};
