-- Add RecommendationCall table
-- One row per *recommendation call* (not per phone) so the admin
-- "Last recommendation → Top results" panel can show the top-3 phones
-- from the *exact* most-recent call without fanning out into
-- RecommendationHistory.

CREATE TABLE IF NOT EXISTS "recommendation_calls" (
    "call_id"      UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"      UUID NOT NULL,
    "persona"      VARCHAR(60),
    "budget"       JSONB,
    "top_results"  JSONB, -- [{ phoneId, modelName, brand, rank, score }]
    "served_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_calls_pkey" PRIMARY KEY ("call_id"),

    CONSTRAINT "recommendation_calls_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "recommendation_calls_user_id_served_at_idx"
    ON "recommendation_calls"("user_id", "served_at" DESC);
