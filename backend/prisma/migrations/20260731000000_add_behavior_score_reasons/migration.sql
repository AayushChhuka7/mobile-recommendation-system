-- Add the `reasons` JSONB column to `behavior_scores`.
--
-- The Prisma schema (behaviorAnalyzer.mjs Phase 6 — explainability LRU)
-- declares:
--   reasons   Json?    @map("reasons")
-- but the original behaviour-event-log migration
-- (20260727000000_add_step_b_behaviour_event_log) was authored before
-- Phase 6 landed and did not include the column. The generated Prisma
-- client was also never re-generated against the updated schema, so
-- `prisma.behaviorScore.findUnique({ select: { reasons: true } })`
-- throws PrismaClientValidationError("Unknown field `reasons`").
--
-- This migration back-fills the column on existing rows (NULL default),
-- matching the schema's `Json?` (nullable) shape.

ALTER TABLE "behavior_scores"
    ADD COLUMN IF NOT EXISTS "reasons" JSONB;
