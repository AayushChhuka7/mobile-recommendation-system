# SQL — Schema Additions for ML Tracking

These SQL files add the tables the project currently lacks. They are written
for PostgreSQL 16 (the project's existing database). Run them with
`psql -d mobile_rec -f project_review/sql/01_segment_table.sql` etc.

None of these scripts DROP or ALTER existing tables. They are pure additions.

| # | File | Purpose |
| - | ---- | ------- |
| 1 | `01_segment_table.sql`         | Persistent segment catalog (Premium / RFM-tiers / GMM-clusters). |
| 2 | `02_segment_membership.sql`    | Many-to-many: which customer is in which segment, with probability. |
| 3 | `03_recommendation_log.sql`    | Per-request log of recommendations served, used for offline NDCG/MAP. |
| 4 | `04_model_registry.sql`        | Versioned model registry (analogous to MLflow). |
| 5 | `05_drift_log.sql`             | Weekly drift metric history (PSI, KS, accuracy decay). |
| 6 | `06_user_recommendation_pre_agg.sql` | Materialised view to speed up LambdaMART training joins. |
