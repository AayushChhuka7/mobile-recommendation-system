-- One-shot patch to align the dev `phones` table with `schema.prisma`.
-- Adds the columns Prisma's generated client expects so the FE's
-- `/api/phones` and `/api/recommend/auto` endpoints stop 500-ing on
-- missing-column errors.
ALTER TABLE phones ADD COLUMN IF NOT EXISTS released_at        TIMESTAMPTZ;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS stock_state        VARCHAR(20);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS stock_updated_at   TIMESTAMPTZ;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS image_url          VARCHAR(500);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS image_path         VARCHAR(500);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS antutu_score       INTEGER;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS battery_mah        INTEGER;
ALTER TABLE phones ADD COLUMN IF NOT EXISTS source             VARCHAR(40);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS source_url         VARCHAR(500);
ALTER TABLE phones ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE phones ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();