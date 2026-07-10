-- CreateEnum
CREATE TYPE "CameraPreference" AS ENUM ('Sensible', 'Photophile', 'Selfie-Addict');

-- CreateEnum
CREATE TYPE "UsageType" AS ENUM ('Student', 'Gamer', 'Business', 'Casual', 'Creator');

-- CreateEnum
CREATE TYPE "BudgetSegment" AS ENUM ('Budget Explorer', 'Affordable Buyer', 'Mid Range Buyer', 'Premium Buyer', 'Luxury Buyer');

-- CreateEnum
CREATE TYPE "TechTier" AS ENUM ('Budget', 'Reasonable', 'Flagship Killer', 'Tech Savvy', 'Luxurious');

-- CreateEnum
CREATE TYPE "SegmentConfidence" AS ENUM ('provisional', 'confirmed');

-- CreateTable
CREATE TABLE "user_profiles" (
    "profile_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "age" SMALLINT,
    "gender" VARCHAR(20),
    "country" VARCHAR(80),
    "state" VARCHAR(80),
    "city" VARCHAR(80),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "preference_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "max_budget" DECIMAL(10,2) NOT NULL,
    "camera_preference" "CameraPreference" NOT NULL,
    "usage_type" "UsageType" NOT NULL,
    "preferred_brand" VARCHAR(60) NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("preference_id")
);

-- CreateTable
CREATE TABLE "phones" (
    "phone_id" UUID NOT NULL,
    "brand" VARCHAR(60) NOT NULL,
    "model_name" VARCHAR(120) NOT NULL,
    "price" DECIMAL(10,2),
    "antutu_score" INTEGER,
    "ram_gb" INTEGER,
    "storage_gb" INTEGER,
    "battery_mah" INTEGER,
    "charging_watts" INTEGER,
    "display_type" VARCHAR(40),
    "display_ppi" INTEGER,
    "camera_score" DECIMAL(5,2),
    "front_camera_score" DECIMAL(5,2),
    "os_name" VARCHAR(40),
    "supports_5g" BOOLEAN NOT NULL DEFAULT false,
    "supports_nfc" BOOLEAN NOT NULL DEFAULT false,
    "dual_sim" BOOLEAN NOT NULL DEFAULT false,
    "source" VARCHAR(40),
    "source_url" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "discontinued_at" TIMESTAMP(3),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phones_pkey" PRIMARY KEY ("phone_id")
);

-- CreateTable
CREATE TABLE "recommendation_history" (
    "history_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "search_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query_id" UUID,
    "filters_json" JSONB,
    "performance_match" DECIMAL(5,2),
    "camera_match" DECIMAL(5,2),
    "battery_match" DECIMAL(5,2),
    "display_match" DECIMAL(5,2),
    "budget_match" DECIMAL(5,2),
    "brand_match" DECIMAL(5,2),
    "overall_compatibility" DECIMAL(5,2),
    "persona_snapshot" VARCHAR(60),
    "clicked" BOOLEAN NOT NULL DEFAULT false,
    "compared" BOOLEAN NOT NULL DEFAULT false,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "purchased" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recommendation_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateTable
CREATE TABLE "customer_profile" (
    "profile_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "budget_segment" "BudgetSegment",
    "tech_tier" "TechTier",
    "camera_preference" "CameraPreference",
    "software_segment" VARCHAR(40),
    "favorite_brand" VARCHAR(60),
    "preferred_ram_gb" INTEGER,
    "preferred_storage_gb" INTEGER,
    "recommendation_persona" VARCHAR(60),
    "avg_performance_match" DECIMAL(5,2),
    "avg_camera_match" DECIMAL(5,2),
    "avg_front_camera_match" DECIMAL(5,2),
    "avg_budget" DECIMAL(10,2),
    "avg_battery_match" DECIMAL(5,2),
    "avg_display_match" DECIMAL(5,2),
    "segment_confidence" "SegmentConfidence" NOT NULL DEFAULT 'provisional',
    "search_count" INTEGER NOT NULL DEFAULT 0,
    "total_recommendations" INTEGER NOT NULL DEFAULT 0,
    "total_comparisons" INTEGER NOT NULL DEFAULT 0,
    "total_wishlist" INTEGER NOT NULL DEFAULT 0,
    "last_updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "wishlist" (
    "wishlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_id" UUID NOT NULL,
    "added_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_pkey" PRIMARY KEY ("wishlist_id")
);

-- CreateTable
CREATE TABLE "comparison_history" (
    "comparison_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_id_a" UUID NOT NULL,
    "phone_id_b" UUID NOT NULL,
    "compared_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_history_pkey" PRIMARY KEY ("comparison_id")
);

-- CreateTable
CREATE TABLE "admin_stats_cache" (
    "stat_id" UUID NOT NULL,
    "computed_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "most_recommended_brand" VARCHAR(60),
    "most_recommended_phone" VARCHAR(120),
    "avg_user_budget" DECIMAL(10,2),
    "most_popular_persona" VARCHAR(60),
    "avg_compatibility" DECIMAL(5,2),
    "most_compared_phone" VARCHAR(120),
    "most_viewed_phone" VARCHAR(120),

    CONSTRAINT "admin_stats_cache_pkey" PRIMARY KEY ("stat_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE INDEX "user_preferences_user_id_idx" ON "user_preferences"("user_id");

-- CreateIndex
CREATE INDEX "idx_phones_brand" ON "phones"("brand");

-- CreateIndex
CREATE INDEX "idx_phones_price" ON "phones"("price");

-- CreateIndex
CREATE INDEX "idx_phones_antutu" ON "phones"("antutu_score");

-- CreateIndex
CREATE INDEX "idx_phones_camera" ON "phones"("camera_score");

-- CreateIndex
CREATE INDEX "idx_phones_is_active" ON "phones"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "phones_brand_model_name_key" ON "phones"("brand", "model_name");

-- CreateIndex
CREATE INDEX "idx_rec_history_user_date" ON "recommendation_history"("user_id", "search_date" DESC);

-- CreateIndex
CREATE INDEX "idx_rec_history_phone" ON "recommendation_history"("phone_id");

-- CreateIndex
CREATE INDEX "idx_rec_history_query" ON "recommendation_history"("query_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profile_user_id_key" ON "customer_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_user_id_phone_id_key" ON "wishlist"("user_id", "phone_id");

-- CreateIndex
CREATE INDEX "idx_comparison_user" ON "comparison_history"("user_id", "compared_date" DESC);

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_history" ADD CONSTRAINT "recommendation_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_history" ADD CONSTRAINT "recommendation_history_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phones"("phone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist" ADD CONSTRAINT "wishlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist" ADD CONSTRAINT "wishlist_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phones"("phone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_history" ADD CONSTRAINT "comparison_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_history" ADD CONSTRAINT "comparison_history_phone_id_a_fkey" FOREIGN KEY ("phone_id_a") REFERENCES "phones"("phone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_history" ADD CONSTRAINT "comparison_history_phone_id_b_fkey" FOREIGN KEY ("phone_id_b") REFERENCES "phones"("phone_id") ON DELETE RESTRICT ON UPDATE CASCADE;
