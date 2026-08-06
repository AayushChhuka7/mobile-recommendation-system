-- Add a nullable phone_id column to browsing_history so the
-- `safeRecordBrowseEvent` dedup gate can recognise an already-tracked
-- phone by its Phones UUID as well as by the human-readable label.
--
-- The browse source row stream is intentionally NOT FK-linked to Phones
-- (the table stores fictional / pre-release / discontinued entries).
-- phoneId is therefore nullable and has no foreign-key constraint —
-- when the caller *does* know the Phones row, it gets stamped here for
-- the dedup index; legacy rows and unrecognised labels stay null.
ALTER TABLE "browsing_history"
  ADD COLUMN "phone_id" UUID;

-- Speeds up the dedup lookup "latest 30 rows for this user filtered by
-- phoneId". The original index is on (user_id, viewed_at DESC) and
-- covers the existing `lastBrowses` orderBy, so we add a sibling
-- index keyed on phone_id to make the dedup path an index hit instead
-- of a heap scan.
CREATE INDEX "browsing_history_user_id_phone_id_idx"
  ON "browsing_history" ("user_id", "phone_id");
