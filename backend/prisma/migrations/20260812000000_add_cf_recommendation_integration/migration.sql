-- Customer-segmentation + collaborative-filtering integration.
--
-- Two new tables back the new hybrid recommender that combines the
-- existing rule-based + content-based pipeline with the trained
-- CF recommender served from `ML Model/filtering/cf_service/`.
--
--   customer_cluster            one row per app user, lazily
--                                populated on first lookup.
--                                `cluster_id` matches the KMeans
--                                label space (0..3 for k=4); the
--                                `cluster_name` is cached from
--                                `cluster_profiles.csv` so the FE
--                                doesn't have to round-trip through
--                                the segmentation CSV on every mount.
--                                `cf_customer_id` is the CF dataset
--                                customer_id (CUST-XXXXXXXX) — set for
--                                users imported from customer_dataset.csv
--                                whose email is
--                                `${customerId}@import.local`.
--
--   cf_recommendation_logs      one row per served CF call. Mirrors
--                                what the FastAPI service returned so
--                                admin tooling and offline analytics
--                                can replay the served list without
--                                re-running the model.
--
-- Both tables are isolated from the existing recommendation system
-- (which already has `recommendation_history`, `recommendation_logs`,
-- `recommendation_calls`) — they are additive, not replacements.

CREATE TABLE "customer_clusters" (
    "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"       UUID NOT NULL UNIQUE,
    "cluster_id"    INTEGER NOT NULL,
    "cluster_name"  VARCHAR(80) NOT NULL,
    "cf_customer_id" VARCHAR(40),
    "assigned_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_clusters_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
        ON DELETE CASCADE
);

CREATE INDEX "customer_clusters_cluster_id_idx"
    ON "customer_clusters"("cluster_id");

CREATE TABLE "cf_recommendation_logs" (
    "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"       UUID NOT NULL,
    "cf_customer_id" VARCHAR(40),
    "is_cold_start" BOOLEAN NOT NULL DEFAULT FALSE,
    "model_names"   TEXT NOT NULL,
    "scores"        TEXT NOT NULL,
    "reasons"       TEXT NOT NULL,
    "served_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cf_recommendation_logs_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
        ON DELETE CASCADE
);

CREATE INDEX "cf_recommendation_logs_user_id_served_at_idx"
    ON "cf_recommendation_logs"("user_id", "served_at" DESC);