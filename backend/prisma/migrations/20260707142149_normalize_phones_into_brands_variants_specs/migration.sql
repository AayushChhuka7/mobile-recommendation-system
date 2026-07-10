/*
  Warnings:

  - You are about to drop the column `most_compared_phone` on the `admin_stats_cache` table. All the data in the column will be lost.
  - You are about to drop the column `most_recommended_phone` on the `admin_stats_cache` table. All the data in the column will be lost.
  - You are about to drop the column `most_viewed_phone` on the `admin_stats_cache` table. All the data in the column will be lost.
  - You are about to drop the column `brand` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `camera_score` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `charging_watts` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `display_ppi` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `display_type` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `dual_sim` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `front_camera_score` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `os_name` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `ram_gb` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `storage_gb` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `supports_5g` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `supports_nfc` on the `phones` table. All the data in the column will be lost.
  - You are about to drop the column `preferred_brand` on the `user_preferences` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[brand_id,model_name]` on the table `phones` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `brand_id` to the `phones` table without a default value. This is not possible if the table is not empty.

*/
-- Drop the reporting views that depend on the columns we're about to drop.
-- They are recreated at the end of this migration against the new schema.
-- Prisma cannot model SQL views, so the original view definitions
-- (20260707111332_add_reporting_views) live as hand-written SQL.
DROP VIEW IF EXISTS "admin_live_stats";
DROP VIEW IF EXISTS "user_analytics";

-- DropIndex
DROP INDEX "idx_phones_brand";

-- DropIndex
DROP INDEX "idx_phones_camera";

-- DropIndex
DROP INDEX "idx_phones_price";

-- DropIndex
DROP INDEX "phones_brand_model_name_key";

-- AlterTable
ALTER TABLE "admin_stats_cache" DROP COLUMN "most_compared_phone",
DROP COLUMN "most_recommended_phone",
DROP COLUMN "most_viewed_phone",
ADD COLUMN     "most_compared_phone_id" UUID,
ADD COLUMN     "most_recommended_phone_id" UUID,
ADD COLUMN     "most_viewed_phone_id" UUID;

-- AlterTable
ALTER TABLE "phones" DROP COLUMN "brand",
DROP COLUMN "camera_score",
DROP COLUMN "charging_watts",
DROP COLUMN "display_ppi",
DROP COLUMN "display_type",
DROP COLUMN "dual_sim",
DROP COLUMN "front_camera_score",
DROP COLUMN "os_name",
DROP COLUMN "price",
DROP COLUMN "ram_gb",
DROP COLUMN "storage_gb",
DROP COLUMN "supports_5g",
DROP COLUMN "supports_nfc",
ADD COLUMN     "brand_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "user_preferences" DROP COLUMN "preferred_brand",
ADD COLUMN     "preferred_brand_id" UUID;

-- CreateTable
CREATE TABLE "brands" (
    "brand_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "logo_url" VARCHAR(500),
    "website" VARCHAR(200),
    "country" VARCHAR(80),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("brand_id")
);

-- CreateTable
CREATE TABLE "phone_variants" (
    "variant_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "ram_gb" INTEGER NOT NULL,
    "storage_gb" INTEGER NOT NULL,
    "price" DECIMAL(10,2),
    "storage_type" VARCHAR(20),
    "colors" JSON,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_variants_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "phone_specs" (
    "spec_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "network_technology" VARCHAR(100),
    "supports_5g" BOOLEAN NOT NULL DEFAULT false,
    "supports_nfc" BOOLEAN NOT NULL DEFAULT false,
    "dual_sim" BOOLEAN NOT NULL DEFAULT false,
    "sim_type" VARCHAR(50),
    "wifi" VARCHAR(100),
    "bluetooth_version" VARCHAR(20),
    "usb_type" VARCHAR(50),
    "headphone_jack" BOOLEAN,
    "gps" BOOLEAN NOT NULL DEFAULT true,
    "sensors" JSON,
    "display_type" VARCHAR(50),
    "refresh_rate_hz" INTEGER,
    "display_size_inch" DECIMAL(4,2),
    "resolution" VARCHAR(30),
    "ppi_density" INTEGER,
    "screen_to_body_pct" DECIMAL(5,2),
    "display_protection" VARCHAR(100),
    "os" VARCHAR(40),
    "os_version" VARCHAR(40),
    "chipset" VARCHAR(100),
    "process_node_nm" VARCHAR(20),
    "cpu" VARCHAR(200),
    "gpu" VARCHAR(200),
    "main_camera_mp" VARCHAR(50),
    "lens_count" INTEGER,
    "main_aperture" VARCHAR(20),
    "ois" BOOLEAN DEFAULT false,
    "sensor_size" VARCHAR(50),
    "camera_4k_video" BOOLEAN,
    "camera_video" VARCHAR(200),
    "selfie_camera_mp" VARCHAR(50),
    "selfie_4k_video" BOOLEAN,
    "dimensions" VARCHAR(100),
    "weight" DECIMAL(6,2),
    "build_material" VARCHAR(100),
    "ip_rating" VARCHAR(10),
    "battery_mah" INTEGER,
    "wired_charging_w" INTEGER,
    "wireless_charging_w" INTEGER,
    "reverse_wireless_charging" BOOLEAN,
    "announced" DATE,
    "status" VARCHAR(50),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_specs_pkey" PRIMARY KEY ("spec_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE INDEX "phone_variants_phone_id_idx" ON "phone_variants"("phone_id");

-- CreateIndex
CREATE INDEX "phone_variants_price_idx" ON "phone_variants"("price");

-- CreateIndex
CREATE UNIQUE INDEX "phone_variants_phone_id_ram_gb_storage_gb_key" ON "phone_variants"("phone_id", "ram_gb", "storage_gb");

-- CreateIndex
CREATE UNIQUE INDEX "phone_specs_phone_id_key" ON "phone_specs"("phone_id");

-- CreateIndex
CREATE INDEX "phone_specs_supports_5g_idx" ON "phone_specs"("supports_5g");

-- CreateIndex
CREATE INDEX "phone_specs_os_idx" ON "phone_specs"("os");

-- CreateIndex
CREATE INDEX "admin_stats_cache_computed_date_idx" ON "admin_stats_cache"("computed_date" DESC);

-- CreateIndex
CREATE INDEX "phones_brand_id_idx" ON "phones"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "phones_brand_id_model_name_key" ON "phones"("brand_id", "model_name");

-- CreateIndex
CREATE INDEX "user_preferences_preferred_brand_id_idx" ON "user_preferences"("preferred_brand_id");

-- AddForeignKey
ALTER TABLE "phones" ADD CONSTRAINT "phones_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("brand_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_variants" ADD CONSTRAINT "phone_variants_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phones"("phone_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_specs" ADD CONSTRAINT "phone_specs_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phones"("phone_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_preferred_brand_id_fkey" FOREIGN KEY ("preferred_brand_id") REFERENCES "brands"("brand_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_stats_cache" ADD CONSTRAINT "admin_stats_cache_most_recommended_phone_id_fkey" FOREIGN KEY ("most_recommended_phone_id") REFERENCES "phones"("phone_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_stats_cache" ADD CONSTRAINT "admin_stats_cache_most_compared_phone_id_fkey" FOREIGN KEY ("most_compared_phone_id") REFERENCES "phones"("phone_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_stats_cache" ADD CONSTRAINT "admin_stats_cache_most_viewed_phone_id_fkey" FOREIGN KEY ("most_viewed_phone_id") REFERENCES "phones"("phone_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "idx_comparison_user" RENAME TO "comparison_history_user_id_compared_date_idx";

-- RenameIndex
ALTER INDEX "idx_phones_antutu" RENAME TO "phones_antutu_score_idx";

-- RenameIndex
ALTER INDEX "idx_phones_is_active" RENAME TO "phones_is_active_idx";

-- RenameIndex
ALTER INDEX "idx_rec_history_phone" RENAME TO "recommendation_history_phone_id_idx";

-- RenameIndex
ALTER INDEX "idx_rec_history_query" RENAME TO "recommendation_history_query_id_idx";

-- RenameIndex
ALTER INDEX "idx_rec_history_user_date" RENAME TO "recommendation_history_user_id_search_date_idx";

-- ============================================================
-- Recreate the reporting views dropped at the top of this migration.
-- Schema change: `phones.brand VARCHAR(60)` → `phones.brand_id UUID → brands.name`.
-- The view now joins through `brands` to get the brand name.
-- `user_analytics` is unchanged (it only references `customer_profile`).
-- ============================================================
CREATE OR REPLACE VIEW "user_analytics" AS
SELECT
    u.user_id,
    u.name,
    cp.favorite_brand,
    cp.avg_budget,
    cp.recommendation_persona,
    cp.total_recommendations,
    cp.total_comparisons,
    cp.total_wishlist
FROM users u
JOIN customer_profile cp ON cp.user_id = u.user_id;

CREATE OR REPLACE VIEW "admin_live_stats" AS
SELECT
    (SELECT b.name FROM recommendation_history rh
        JOIN phones p ON p.phone_id = rh.phone_id
        JOIN brands b ON b.brand_id = p.brand_id
        GROUP BY b.name ORDER BY COUNT(*) DESC LIMIT 1)             AS most_recommended_brand,
    (SELECT AVG(max_budget) FROM user_preferences)                    AS avg_user_budget,
    (SELECT recommendation_persona FROM customer_profile
        GROUP BY recommendation_persona ORDER BY COUNT(*) DESC LIMIT 1) AS most_popular_persona,
    (SELECT AVG(overall_compatibility) FROM recommendation_history)     AS avg_compatibility;
