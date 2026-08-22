-- Add a covering index for the `isDuplicateEvent` lookup in
-- behaviorAnalyzer.recordEvent. The dedup query is:
--
--   SELECT 1 FROM events
--   WHERE user_id = ? AND event_type = ? AND phone_id = ?
--     AND created_at >= now() - interval '30 seconds'
--   ORDER BY created_at DESC LIMIT 1;
--
-- The existing (user_id, created_at DESC) index is wide enough but
-- filters on event_type + phone_id in the heap. This composite index
-- lets the dedup lookup be a single index scan with a partial
-- timestamp range — important during bursty click-loops where a user
-- taps the same card 4× in a row.
CREATE INDEX "events_user_id_event_type_phone_id_created_at_idx"
  ON "events" ("user_id", "event_type", "phone_id", "created_at" DESC);
