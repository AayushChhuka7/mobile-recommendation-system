-- 03_recommendation_log.sql
-- Every recommendation the API serves is logged here. Combined with the
-- click/wishlist/buy signal, this is the training set for the LambdaMART
-- ranker (xgboost_ideas/06_lambda_ranker.md).
--
-- Run: psql -d mobile_rec -f 03_recommendation_log.sql

CREATE TABLE IF NOT EXISTS rec_log (
    rec_id          BIGSERIAL    PRIMARY KEY,
    user_id         INTEGER      NOT NULL,
    persona         VARCHAR(32)  NOT NULL,                       -- 'Gamer', 'Camera_Lover', ...
    model_version   VARCHAR(32)  NOT NULL,                       -- 'v0.4.1'
    requested_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ranked_ids      INTEGER[]    NOT NULL,                       -- ordered list of mobile_id returned
    ranked_scores   REAL[]       NOT NULL,                       -- matching scores
    explanations    JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- per-position SHAP reasons
    -- Feedback columns (filled in later by /feedback endpoint)
    clicked_position SMALLINT,                                   -- 1-indexed position the user clicked, NULL=no click
    wished_position  SMALLINT,
    purchased_mobile_id INTEGER,
    feedback_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rec_log_user        ON rec_log (user_id);
CREATE INDEX IF NOT EXISTS idx_rec_log_persona     ON rec_log (persona);
CREATE INDEX IF NOT EXISTS idx_rec_log_requested   ON rec_log (requested_at);
CREATE INDEX IF NOT EXISTS idx_rec_log_clicked     ON rec_log (clicked_position) WHERE clicked_position IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rec_log_model       ON rec_log (model_version);

COMMENT ON TABLE rec_log IS
    'Append-only log of every recommendation served + the eventual user action. Feeds LambdaMART training.';