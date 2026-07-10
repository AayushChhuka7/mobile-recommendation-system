// Format phone for list view (lightweight)
export const formatPhoneListItem = (phone) => {
  const cheapestVariant = getCheapestVariant(phone.variants);

  return {
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,

    brand: phone.brand
      ? {
          id: phone.brand.brandId,
          name: phone.brand.name,
          logoUrl: phone.brand.logoUrl,
        }
      : null,

    keySpecs: {
      os: phone.specs?.os || null,
      display: phone.specs?.displaySize || null,
      refreshRate: phone.specs?.refreshRate || null,
      camera: phone.specs?.mainCamera || null,
      battery: phone.specs?.batteryMah || null,
      has5G: phone.specs?.supports5g || false,
      hasNfc: phone.specs?.supportsNfc || false,
    },

    cheapestVariant,
  };
};

// Format phone for detail view (full)
export const formatPhoneDetail = (phone) => {
  const cheapestVariant = getCheapestVariant(phone.variants);
  const priceRange = getPriceRange(phone.variants);

  return {
    id: phone.phoneId,
    modelName: phone.modelName,
    imageUrl: phone.imageUrl,
    antutuScore: phone.antutuScore,
    isActive: phone.isActive,
    source: phone.source,

    brand: phone.brand
      ? {
          id: phone.brand.brandId,
          name: phone.brand.name,
          logoUrl: phone.brand.logoUrl,
          website: phone.brand.website,
          country: phone.brand.country,
        }
      : null,

    specs: phone.specs
      ? {
          network: {
            technology: phone.specs.networkTech,
            supports5g: phone.specs.supports5g,
            supportsNfc: phone.specs.supportsNfc,
            dualSim: phone.specs.dualSim,
            simType: phone.specs.simType,
            wifi: phone.specs.wifi,
            bluetooth: phone.specs.bluetooth,
            usbType: phone.specs.usbType,
            headphoneJack: phone.specs.headphoneJack,
            gps: phone.specs.gps,
          },
          display: {
            type: phone.specs.displayType,
            size: phone.specs.displaySize,
            refreshRate: phone.specs.refreshRate,
            resolution: phone.specs.resolution,
            ppiDensity: phone.specs.ppiDensity,
            screenToBody: phone.specs.screenToBody,
            protection: phone.specs.displayProtection,
          },
          platform: {
            os: phone.specs.os,
            chipset: phone.specs.chipset,
            processNode: phone.specs.processNode,
            cpu: phone.specs.cpu,
            gpu: phone.specs.gpu,
          },
          camera: {
            main: phone.specs.mainCamera,
            lensCount: phone.specs.lensCount,
            aperture: phone.specs.mainAperture,
            ois: phone.specs.ois,
            sensorSize: phone.specs.sensorSize,
            video4k: phone.specs.camera4K,
            selfie: phone.specs.selfieCamera,
            selfie4k: phone.specs.selfie4K,
          },
          physical: {
            dimensions: phone.specs.dimensions,
            weight: phone.specs.weight,
          },
          battery: {
            capacity: phone.specs.batteryMah,
            wiredCharging: phone.specs.wiredCharging,
            reverseWireless: phone.specs.reverseWireless,
          },
          metadata: {
            announced: phone.specs.announced,
            status: phone.specs.status,
          },
        }
      : null,

    variants: phone.variants
      ? phone.variants.map((v) => ({
          id: v.variantId,
          ram: v.ramGb,
          storage: v.storageGb,
          storageType: v.storageType,
          price: v.price,
          isAvailable: v.isAvailable,
        }))
      : [],

    pricing: {
      cheapest: cheapestVariant,
      range: priceRange,
    },
  };
};

// Helper: Get cheapest variant
const getCheapestVariant = (variants) => {
  if (!variants || variants.length === 0) return null;

  const cheapest = variants.reduce((min, v) => {
    if (!v.price) return min;
    if (!min || !min.price) return v;
    return parseFloat(v.price) < parseFloat(min.price) ? v : min;
  }, null);

  return cheapest
    ? {
        ram: cheapest.ramGb,
        storage: cheapest.storageGb,
        price: cheapest.price,
        storageType: cheapest.storageType,
      }
    : null;
};

// Helper: Get price range
const getPriceRange = (variants) => {
  if (!variants || variants.length === 0) return null;

  const prices = variants
    .map((v) => (v.price ? parseFloat(v.price) : null))
    .filter((p) => p !== null);

  if (prices.length === 0) return null;

  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    currency: "EUR",
  };
};
