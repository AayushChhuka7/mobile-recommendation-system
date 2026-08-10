-- 02_segment_membership.sql
-- Soft-cluster assignments: customer × segment × probability.
-- For hard clusters (K-Means), probability = 1.0.
-- For GMM, probability = posterior.
--
-- Run: psql -d mobile_rec -f 02_segment_membership.sql

CREATE TABLE IF NOT EXISTS segment_membership (
    customer_id     INTEGER      NOT NULL,
    segment_id      INTEGER      NOT NULL REFERENCES segment(segment_id) ON DELETE CASCADE,
    probability     REAL         NOT NULL CHECK (probability BETWEEN 0 AND 1),
    assigned_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    model_version   VARCHAR(32)  NOT NULL,         -- e.g. 'v0.4.1'
    PRIMARY KEY (customer_id, segment_id, model_version)
);

CREATE INDEX IF NOT EXISTS idx_segment_membership_segment ON segment_membership (segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_membership_model   ON segment_membership (model_version);

COMMENT ON TABLE segment_membership IS
    'Soft assignment of each customer to one or more segments.';