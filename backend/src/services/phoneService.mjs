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

// Add these functions after getAllPhones

// GET /api/phones/search?q=iPhone
export const searchPhones = async (queryParams) => {
  const searchTerm = queryParams.q || queryParams.search;

  if (!searchTerm) {
    return {
      phones: [],
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    };
  }

  const page = parseInt(queryParams.page) || 1;
  const limit = Math.min(parseInt(queryParams.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const where = {
    isActive: true,
    modelName: { contains: searchTerm, mode: "insensitive" },
  };

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
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.phones.count({ where }),
  ]);

  const pagination = buildPaginationMeta({ page, limit, total });

  return { phones, pagination };
};

// GET /api/phones/brand/:brandName
export const getPhonesByBrand = async (brandName, queryParams) => {
  const page = parseInt(queryParams.page) || 1;
  const limit = Math.min(parseInt(queryParams.limit) || 20, 100);
  const skip = (page - 1) * limit;

  // First find the brand
  const brand = await prisma.brands.findFirst({
    where: { name: { equals: brandName, mode: "insensitive" } },
  });

  if (!brand) {
    throw notFound(`Brand '${brandName}' not found`);
  }

  const where = {
    isActive: true,
    brandId: brand.brandId,
  };

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
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.phones.count({ where }),
  ]);

  const pagination = buildPaginationMeta({ page, limit, total });

  return { brand, phones, pagination };
};

// GET /api/phones/filters
export const getFilterOptions = async () => {
  const [brands, osList, displayTypes, years, priceRange] = await Promise.all([
    // All brands with phone counts
    prisma.brands.findMany({
      select: {
        brandId: true,
        name: true,
        logoUrl: true,
        _count: { select: { phones: true } },
      },
      orderBy: { name: "asc" },
    }),

    // Distinct OS versions
    prisma.phoneSpecs.findMany({
      select: { os: true },
      distinct: ["os"],
      where: { os: { not: null } },
      orderBy: { os: "asc" },
    }),

    // Distinct display types
    prisma.phoneSpecs.findMany({
      select: { displayType: true },
      distinct: ["displayType"],
      where: { displayType: { not: null } },
      orderBy: { displayType: "asc" },
    }),

    // Available years
    prisma.$queryRaw`
      SELECT DISTINCT EXTRACT(YEAR FROM announced)::int as year
      FROM phone_specs
      WHERE announced IS NOT NULL
      ORDER BY year DESC
    `,

    // Price range
    prisma.phoneVariants.aggregate({
      _min: { price: true },
      _max: { price: true },
    }),
  ]);

  return {
    brands: brands.map((b) => ({
      id: b.brandId,
      name: b.name,
      logoUrl: b.logoUrl,
      phoneCount: b._count.phones,
    })),
    os: osList.map((o) => o.os).filter(Boolean),
    displayTypes: displayTypes.map((d) => d.displayType).filter(Boolean),
    years: years.map((y) => y.year),
    priceRange: {
      min: priceRange._min.price ? parseFloat(priceRange._min.price) : 0,
      max: priceRange._max.price ? parseFloat(priceRange._max.price) : 0,
      currency: "EUR",
    },
    ramOptions: [2, 4, 6, 8, 12, 16],
    storageOptions: [32, 64, 128, 256, 512, 1024],
    features: [
      { key: "has5G", label: "5G Support" },
      { key: "hasNfc", label: "NFC" },
      { key: "hasOis", label: "OIS Camera" },
      { key: "hasHeadphoneJack", label: "Headphone Jack" },
    ],
    sortOptions: [
      { key: "newest", label: "Newest First" },
      { key: "oldest", label: "Oldest First" },
      { key: "name_asc", label: "Name A-Z" },
      { key: "name_desc", label: "Name Z-A" },
      { key: "price_asc", label: "Price Low to High" },
      { key: "price_desc", label: "Price High to Low" },
      { key: "antutu", label: "Performance Score" },
    ],
  };
};

// GET /api/phones/stats
export const getPhoneStats = async () => {
  const [
    totalPhones,
    totalBrands,
    totalVariants,
    priceStats,
    specsStats,
    topBrands,
  ] = await Promise.all([
    prisma.phones.count({ where: { isActive: true } }),
    prisma.brands.count(),
    prisma.phoneVariants.count({ where: { isAvailable: true } }),

    prisma.phoneVariants.aggregate({
      _min: { price: true },
      _max: { price: true },
      _avg: { price: true },
    }),

    // Specs aggregates
    Promise.all([
      prisma.phoneSpecs.count({ where: { supports5g: true } }),
      prisma.phoneSpecs.count({ where: { supportsNfc: true } }),
      prisma.phoneSpecs.count({ where: { ois: true } }),
      prisma.phoneSpecs.aggregate({
        _avg: { batteryMah: true, displaySize: true, lensCount: true },
      }),
    ]),

    // Top 5 brands
    prisma.brands.findMany({
      select: {
        name: true,
        logoUrl: true,
        _count: { select: { phones: true } },
      },
      orderBy: { phones: { _count: "desc" } },
      take: 5,
    }),
  ]);

  const [fiveGCount, nfcCount, oisCount, avgSpecs] = specsStats;

  return {
    totalPhones,
    totalBrands,
    totalVariants,
    pricing: {
      min: priceStats._min.price ? parseFloat(priceStats._min.price) : 0,
      max: priceStats._max.price ? parseFloat(priceStats._max.price) : 0,
      avg: priceStats._avg.price
        ? Math.round(parseFloat(priceStats._avg.price) * 100) / 100
        : 0,
      currency: "EUR",
    },
    features: {
      fiveG: fiveGCount,
      nfc: nfcCount,
      ois: oisCount,
      fiveGPercent:
        totalPhones > 0 ? Math.round((fiveGCount / totalPhones) * 100) : 0,
      nfcPercent:
        totalPhones > 0 ? Math.round((nfcCount / totalPhones) * 100) : 0,
      oisPercent:
        totalPhones > 0 ? Math.round((oisCount / totalPhones) * 100) : 0,
    },
    averages: {
      batteryMah: avgSpecs._avg.batteryMah
        ? Math.round(avgSpecs._avg.batteryMah)
        : 0,
      displaySize: avgSpecs._avg.displaySize
        ? Math.round(parseFloat(avgSpecs._avg.displaySize) * 100) / 100
        : 0,
      lensCount: avgSpecs._avg.lensCount
        ? Math.round(parseFloat(avgSpecs._avg.lensCount) * 10) / 10
        : 0,
    },
    topBrands: topBrands.map((b) => ({
      name: b.name,
      logoUrl: b.logoUrl,
      phoneCount: b._count.phones,
    })),
  };
};
// POST /api/phones/compare
// Body: { phoneIds: ["uuid1", "uuid2", "uuid3"] }
export const comparePhones = async (phoneIds) => {
  // Maximum 5 phones for comparison
  if (phoneIds.length > 5) {
    throw badRequest("Maximum 5 phones can be compared at once");
  }

  if (phoneIds.length < 2) {
    throw badRequest("At least 2 phones are required for comparison");
  }

  const phones = await prisma.phones.findMany({
    where: {
      phoneId: { in: phoneIds },
      isActive: true,
    },
    include: {
      brand: true,
      specs: true,
      variants: {
        where: { isAvailable: true },
        orderBy: { price: "asc" },
      },
    },
  });

  // Check if all phones were found
  if (phones.length !== phoneIds.length) {
    throw notFound("One or more phones not found");
  }

  // Return phones in the same order as requested IDs
  return phoneIds.map((id) => phones.find((p) => p.phoneId === id));
};

// GET /api/phones/featured — Popular/featured phones
export const getFeaturedPhones = async () => {
  const phones = await prisma.phones.findMany({
    where: {
      isActive: true,
      specs: {
        supports5g: true,
      },
    },
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
    orderBy: { antutuScore: "desc" },
    take: 10,
  });

  return phones;
};

// GET /api/phones/latest — Latest releases
export const getLatestPhones = async () => {
  const phones = await prisma.phones.findMany({
    where: {
      isActive: true,
      specs: {
        announced: { not: null },
      },
    },
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
          announced: true,
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
    orderBy: {
      specs: { announced: "desc" },
    },
    take: 10,
  });

  return phones;
};

// GET /api/phones/best-value — Phones under €300 with 6GB+ RAM
export const getBestValuePhones = async () => {
  const phones = await prisma.phones.findMany({
    where: {
      isActive: true,
      variants: {
        some: {
          price: { lte: 300 },
          ramGb: { gte: 6 },
        },
      },
    },
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
        where: { isAvailable: true, price: { lte: 300 }, ramGb: { gte: 6 } },
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
    orderBy: { antutuScore: "desc" },
    take: 10,
  });

  return phones;
};
