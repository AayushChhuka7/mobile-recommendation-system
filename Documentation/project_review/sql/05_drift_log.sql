-- 05_drift_log.sql
-- Drift metrics are computed weekly by the monitoring job (Evidently /
-- Alibi-Detect). One row per (model, feature, week, metric).
--
-- Run: psql -d mobile_rec -f 05_drift_log.sql

CREATE TABLE IF NOT EXISTS drift_log (
    drift_id        BIGSERIAL    PRIMARY KEY,
    model_name      VARCHAR(64)  NOT NULL,
    model_version   VARCHAR(32)  NOT NULL,
    feature_name    VARCHAR(128) NOT NULL,                          -- '*' for label/prediction drift
    metric          VARCHAR(32)  NOT NULL,                          -- 'psi', 'ks', 'js_div', 'chi2'
    value           REAL         NOT NULL,
    threshold       REAL         NOT NULL,
    is_drift        BOOLEAN      NOT NULL,
    window_start    DATE         NOT NULL,
    window_end      DATE         NOT NULL,
    sample_size     INTEGER      NOT NULL,
    computed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drift_log_model   ON drift_log (model_name, model_version);
CREATE INDEX IF NOT EXISTS idx_drift_log_drift   ON drift_log (is_drift) WHERE is_drift;
CREATE INDEX IF NOT EXISTS idx_drift_log_window  ON drift_log (window_end);

COMMENT ON TABLE drift_log IS
    'Per-feature, per-window drift metrics. Used by the retrain trigger.';

-- Helper view: latest drift status per feature
CREATE OR REPLACE VIEW v_latest_drift AS
SELECT DISTINCT ON (model_name, feature_name)
       model_name, feature_name, metric, value, threshold,
       is_drift, window_end, computed_at
  FROM drift_log
 ORDER BY model_name, feature_name, window_end DESC;

COMMENT ON VIEW v_latest_drift IS
    'Most-recent drift status per (model, feature).';