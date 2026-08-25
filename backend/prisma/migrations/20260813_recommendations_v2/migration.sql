-- 2026-08-13_recommendations_v2
--
-- All changes from the 9-fix review pass:
--   1. Impression logging (recommendation_logs gains source/requestId/dwell/clicked/skipped/isTrainingEligible/explorationArm)
--   7. N+1 -> batched: the Phones table is unchanged, but the
--      RecommendationLog changes below let the FE upsert by
--      (userId, phoneId, source, requestId)
--   3. Learned fusion weights: new training_impressions table
--   9. Freshness / trending / stock: new columns on Phones + new
--      phone_trends table
--
-- Apply with:
--   psql $DATABASE_URL -f backend/prisma/migrations/20260813_recommendations_v2/migration.sql
-- then
--   npx prisma migrate dev --name recommendations_v2
--   npx prisma generate
--
-- All ALTERs are idempotent (IF NOT EXISTS / IF EXISTS guards).
-- The unique index on (userId, phoneId, source, requestId) is the
-- one structural change — without it the impression upsert can't
-- find the row to update.

-- 1. RecommendationLog: extensions for Fix #1 impression logging.
ALTER TABLE recommendation_logs
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'click',
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS dwell_ms INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS exploration_arm VARCHAR(40),
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

-- Backfill source from the click bit where it exists (it doesn't
-- today, so this is a no-op; left in for future schemas).
UPDATE recommendation_logs SET source = 'click' WHERE source IS NULL;

-- The unique index that lets the FE upsert by (userId, phoneId, source, requestId).
-- Multiple impressions of the same phone in the same FE session
-- collapse to one row. NULL requestIds are bucketed separately so
-- legacy impressions don't violate uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS impression_unique_idx
  ON recommendation_logs (user_id, phone_id, source, COALESCE(request_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Index for the trainer's "eligible impressions in the last N days" query.
CREATE INDEX IF NOT EXISTS training_eligible_idx
  ON recommendation_logs (is_training_eligible, shown_at DESC)
  WHERE is_training_eligible = TRUE;

-- 3. training_impressions — denormalised table the trainer reads.
CREATE TABLE IF NOT EXISTS training_impressions (
  impression_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           UUID NOT NULL,
  user_id              UUID NOT NULL,
  phone_id             UUID NOT NULL,
  source               VARCHAR(20) NOT NULL,
  position             INT NOT NULL,
  viewport_index       INT,
  s_compatibility      REAL NOT NULL,
  s_customer_pref      REAL NOT NULL,
  s_content_sim        REAL NOT NULL,
  s_search_history     REAL NOT NULL,
  s_value              REAL NOT NULL,
  s_freshness          REAL,
  in_stock             BOOLEAN,
  days_since_release   INT,
  user_persona         VARCHAR(40),
  user_segment         VARCHAR(40),
  has_history          BOOLEAN NOT NULL,
  label_clicked        BOOLEAN,
  label_clicked_at     TIMESTAMPTZ,
  label_dwell_ms       INT,
  label_skipped        BOOLEAN,
  label_purchased      BOOLEAN,
  label_purchased_at   TIMESTAMPTZ,
  is_training_eligible BOOLEAN NOT NULL,
  observed_at          TIMESTAMPTZ NOT NULL,
  labelled_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_observed
  ON training_impressions (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_phone
  ON training_impressions (user_id, phone_id);
CREATE INDEX IF NOT EXISTS train_eligible_clicked_idx
  ON training_impressions (is_training_eligible, label_clicked)
  WHERE is_training_eligible = TRUE;

-- 9. Phone trend + stock + freshness columns on Phones.
ALTER TABLE phones
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_state VARCHAR(20),
  ADD COLUMN IF NOT EXISTS stock_updated_at TIMESTAMPTZ;

-- phone_trends — populated by a nightly job.
CREATE TABLE IF NOT EXISTS phone_trends (
  phone_id        UUID PRIMARY KEY,
  trend_score     REAL NOT NULL DEFAULT 0,
  views_7d        INT NOT NULL DEFAULT 0,
  clicks_7d       INT NOT NULL DEFAULT 0,
  impressions_7d  INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trend_score
  ON phone_trends (trend_score DESC);
