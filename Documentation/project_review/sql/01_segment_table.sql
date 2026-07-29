-- 01_segment_table.sql
-- A persistent catalog of segments. The current segmentation lives only
-- in a notebook artefact; this table is the production-ready home.
--
-- Run: psql -d mobile_rec -f 01_segment_table.sql

CREATE TABLE IF NOT EXISTS segment (
    segment_id        SERIAL PRIMARY KEY,
    code              VARCHAR(64)  NOT NULL UNIQUE,    -- e.g. 'GMM_Premium', 'RFM_Champion'
    name              VARCHAR(128) NOT NULL,           -- human label
    description       TEXT,
    algorithm         VARCHAR(32)  NOT NULL,           -- 'kmeans', 'gmm', 'hdbscan', 'rfm', 'ltv_decile'
    hyperparams       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deprecated_at     TIMESTAMPTZ,                     -- soft-delete so history joins still resolve
    metrics           JSONB        NOT NULL DEFAULT '{}'::jsonb  -- silhouette, BIC, stability
);

CREATE INDEX IF NOT EXISTS idx_segment_algorithm ON segment (algorithm);
CREATE INDEX IF NOT EXISTS idx_segment_code      ON segment (code);

COMMENT ON TABLE segment IS
    'Persistent catalog of customer segments. One row per algorithm + hyperparameter combo.';