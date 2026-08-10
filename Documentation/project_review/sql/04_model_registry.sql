-- 04_model_registry.sql
-- Lightweight MLflow-style registry. Each model artefact is fingerprinted
-- by SHA-256 of the file. The serving layer pins a `production_stage`.
--
-- Run: psql -d mobile_rec -f 04_model_registry.sql

CREATE TABLE IF NOT EXISTS model_registry (
    model_id        SERIAL       PRIMARY KEY,
    name            VARCHAR(64)  NOT NULL,                          -- 'antutu_xgb', 'churn_xgb', ...
    version         VARCHAR(32)  NOT NULL,                          -- 'v0.4.1'
    stage           VARCHAR(16)  NOT NULL DEFAULT 'staging'
                     CHECK (stage IN ('staging', 'production', 'archived', 'failed')),
    artifact_path   TEXT         NOT NULL,                          -- relative path on disk / S3 key
    sha256          CHAR(64)     NOT NULL,
    metrics         JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- R², AUC, NDCG
    params          JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- hyperparams
    feature_schema  JSONB        NOT NULL DEFAULT '{}'::jsonb,      -- column order + dtypes
    card_url        TEXT,                                           -- link to model card markdown
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    promoted_at     TIMESTAMPTZ,
    UNIQUE (name, version)
);

CREATE INDEX IF NOT EXISTS idx_model_registry_name  ON model_registry (name);
CREATE INDEX IF NOT EXISTS idx_model_registry_stage ON model_registry (stage);

-- Enforce only one production model per name
CREATE OR REPLACE FUNCTION enforce_single_production_model()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stage = 'production' THEN
        UPDATE model_registry
           SET stage = 'archived',
               promoted_at = COALESCE(promoted_at, NOW())
         WHERE name = NEW.name
           AND stage = 'production'
           AND version <> NEW.version;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_single_production ON model_registry;
CREATE TRIGGER trg_enforce_single_production
    BEFORE INSERT OR UPDATE OF stage ON model_registry
    FOR EACH ROW
    WHEN (NEW.stage = 'production')
    EXECUTE FUNCTION enforce_single_production_model();

COMMENT ON TABLE model_registry IS
    'Versioned model registry. Only one model per name can be in the production stage at a time.';