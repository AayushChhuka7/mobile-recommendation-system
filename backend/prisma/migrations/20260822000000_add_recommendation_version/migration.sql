-- AUTO recommendation multi-retriever instrumentation.
--
-- Adds `recommendation_version` to `recommendation_logs` so the trainer
-- and offline analytics can distinguish impressions served from the new
-- multi-retriever candidate-generation path (`multi_retriever_v1`) from
-- the legacy single-source Python path (`legacy_v0`). Used for the
-- rollout-bucketed canary comparison in Step 17 of the design doc.
--
-- The column is additive and non-destructive:
--   - Nullable with default `'legacy_v0'` — existing rows auto-populate.
--   - The FE /impressions upsert only touches label columns
--     (`dwell_ms`, `clicked`, `skipped`, `is_training_eligible`,
--     `viewport_index`) — this column is never overwritten by the FE.
--   - POST `/api/recommend` callers never pass `recommendation_version`,
--     so they get `'legacy_v0'` by default and their output is
--     byte-identical to before this migration.
--
-- The unique key `(user_id, phone_id, source, request_id)` is preserved.
-- A secondary index on `(recommendation_version, shown_at DESC)` powers
-- the legacy-vs-multi-retriever comparison query and dashboard panels.

-- AlterTable
ALTER TABLE "recommendation_logs"
    ADD COLUMN "recommendation_version" VARCHAR(32) DEFAULT 'legacy_v0';

-- CreateIndex
CREATE INDEX "recommendation_version_idx"
    ON "recommendation_logs"("recommendation_version", "shown_at" DESC);
