-- 06_user_recommendation_pre_agg.sql
-- Materialised view that joins rec_log + purchases + wishlist to give the
-- LambdaMART trainer one row per (user, candidate, rec_session). This is
-- the LTR "training set" referenced in xgboost_ideas/06_lambda_ranker.md.
--
-- Run: psql -d mobile_rec -f 06_user_recommendation_pre_agg.sql

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_user_rec_ltr AS
SELECT
    rl.rec_id,
    rl.user_id,
    rl.persona,
    rl.model_version,
    rl.requested_at,
    pos.idx                                   AS rank_position,        -- 0-indexed
    (rl.ranked_ids)[pos.idx + 1]              AS mobile_id,
    (rl.ranked_scores)[pos.idx + 1]           AS score,
    -- Relevance label (5 = purchased, 3 = wished, 1 = clicked, 0 = ignored)
    CASE
        WHEN (rl.ranked_ids)[pos.idx + 1] = rl.purchased_mobile_id          THEN 5
        WHEN rl.wished_position   IS NOT NULL
         AND (rl.ranked_ids)[pos.idx + 1] = (rl.ranked_ids)[rl.wished_position]   THEN 3
        WHEN rl.clicked_position  IS NOT NULL
         AND pos.idx + 1 = rl.clicked_position                                THEN 1
        ELSE 0
    END AS label
FROM rec_log rl
CROSS JOIN LATERAL generate_series(0, array_length(rl.ranked_ids, 1) - 1) AS pos(idx)
WHERE rl.feedback_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mv_user_rec_ltr_user
    ON mv_user_rec_ltr (user_id);
CREATE INDEX IF NOT EXISTS idx_mv_user_rec_ltr_session
    ON mv_user_rec_ltr (rec_id);

COMMENT ON MATERIALIZED VIEW mv_user_rec_ltr IS
    'Training set for LambdaMART ranker. One row per (session, position). Refresh after feedback updates.';

-- Suggested refresh schedule (cron):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_rec_ltr;