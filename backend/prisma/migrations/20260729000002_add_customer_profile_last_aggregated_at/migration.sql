-- Add a `last_aggregated_at` watermark to `customer_profile` so the
-- modal profile aggregator (profileAggregator.mjs) can skip
-- re-aggregating on every recommendation call when the data hasn't
-- shifted enough to matter.
--
-- Distinct from `last_updated`, which is `@updatedAt` and bumps on
-- every write (searchCount increment, persona change, etc.) — not a
-- useful throttle signal. `last_aggregated_at` only ticks when the
-- aggregator itself succeeds, so the throttle is a stable equality
-- comparison + a single field read.
ALTER TABLE "customer_profile"
  ADD COLUMN "last_aggregated_at" TIMESTAMP(6);