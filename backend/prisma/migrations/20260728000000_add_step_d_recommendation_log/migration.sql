-- Step D — per-candidate recommendation impression log.
--
-- One row per served candidate (rank + finalScore). Feeds the future
-- customer-segmentation clustering that will reclaim the 0.05
-- popularity slot currently held open in fusionRanker's FUSION_WEIGHTS.
--
-- Schema shape mirrors Prisma model `RecommendationLog` in schema.prisma.
-- Keep both in sync when this migration is regenerated.

CREATE TABLE IF NOT EXISTS "recommendation_logs" (
    "log_id"      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"     UUID         NOT NULL,
    "phone_id"    UUID         NOT NULL,
    "final_score" DOUBLE PRECISION NOT NULL,
    "rank"        INTEGER      NOT NULL,
    "shown_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clicked"     BOOLEAN      NOT NULL DEFAULT FALSE
);

-- FKs: cascade on user delete (logs belong to a session); SetNull on
-- phone delete is the same pattern as admin_stats_cache — a hard-
-- removed phone shouldn't yank the impression history along with it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recommendation_logs_user_id_fkey'
    ) THEN
        ALTER TABLE "recommendation_logs"
            ADD CONSTRAINT "recommendation_logs_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recommendation_logs_phone_id_fkey'
    ) THEN
        ALTER TABLE "recommendation_logs"
            ADD CONSTRAINT "recommendation_logs_phone_id_fkey"
            FOREIGN KEY ("phone_id") REFERENCES "phones"("phone_id") ON DELETE SET NULL;
    END IF;
END $$;

-- Hot lookup: latest impressions for a user (FE analytics).
CREATE INDEX IF NOT EXISTS "IDX_recommendation_logs_user_id_shown_at"
    ON "recommendation_logs" ("user_id", "shown_at" DESC);

-- Hot lookup: which users were shown this phone recently.
CREATE INDEX IF NOT EXISTS "IDX_recommendation_logs_phone_id"
    ON "recommendation_logs" ("phone_id");
