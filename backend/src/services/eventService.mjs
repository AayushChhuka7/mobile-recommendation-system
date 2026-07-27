// eventService — Step B persistence + read helpers.
//
// Three responsibilities:
//   1. `recordEvent` — log the raw event row + apply the analyzer's
//      deltas to the per-(user, tag) BehaviorScore table in a single
//      transaction.
//   2. `loadBehaviorScores` — fetch the rolled-up score map for a user
//      so the ranker can compute the Search History Score (Step D).
//   3. `loadRecentEvents` — feed the Profile Evolution Engine (Step F)
//      a sliding window of recent events.
//
// Re-uses `behaviorAnalyzer` (pure, side-effect-free) — this file is
// the only place we touch Prisma for behaviour data, so the write path
// has exactly one home.

import { prisma } from "../config/prisma.mjs";
import { notFound } from "../utils/ApiError.mjs";
import {
  deltasFor,
  tagsForEvent,
  applyDeltas,
  EVENT_TYPES,
} from "./behaviorAnalyzer.mjs";

// Cap the per-request `payload` so a malicious FE can't blow up the
// `events.payload` JSONB column with megabyte strings.
const MAX_PAYLOAD_BYTES = 4 * 1024;

/**
 * Load a phone row with the minimum spec fields the analyzer needs to
 * derive tags. Returns `null` if the phoneId is missing or doesn't
 * resolve — the caller (controller) should accept `null` and just skip
 * tag derivation.
 */
const fetchPhoneContext = async (phoneId) => {
  if (!phoneId) return null;
  return prisma.phones.findUnique({
    where: { phoneId },
    select: {
      phoneId: true,
      antutuScore: true,
      batteryMah: true,
      brand: { select: { name: true } },
      specs: { select: { chipset: true, mainCamera: true, refreshRate: true } },
      variants: {
        where: { isAvailable: true },
        orderBy: { price: "asc" },
        take: 1,
        select: { price: true, ramGb: true, storageGb: true },
      },
    },
  });
};

/**
 * Record a single behaviour event and update the user's rolled-up
 * behaviour scores in one transaction.
 *
 * The transaction guarantees that we never land in a half-written
 * state: either the event is logged AND the score is updated, or
 * nothing is. A retry / re-fire from the FE won't double-count
 * because the analyzer's decay rule is idempotent enough for our
 * purposes (a duplicate save still adds +4, which is acceptable noise).
 *
 * @param {string} userId
 * @param {string} eventType       one of EVENT_TYPES (else no score update)
 * @param {string|null} phoneId    optional phone reference
 * @param {object|null} payload    small JSON blob (search query, etc.)
 * @returns {Promise<{ event: object, updatedTags: string[] }>}
 */
export const recordEvent = async (userId, eventType, phoneId, payload) => {
  // Defensive checks — these are also enforced by the validator, but
  // we re-check here so a direct service caller (e.g. tests, a future
  // server-side cron) can't bypass them.
  if (typeof eventType !== "string" || !eventType) {
    throw new Error("eventType is required");
  }

  // Trim the payload to keep `events.payload` JSONB sane. We do this
  // *before* the transaction so a 4 MB body doesn't even reach Prisma.
  const safePayload = payload && typeof payload === "object"
    ? JSON.parse(JSON.stringify(payload, (_k, v) => {
        // Stop serialising once we've blown the byte budget.
        if (typeof v === "string" && v.length > 1024) return v.slice(0, 1024);
        return v;
      }))
    : null;

  const tagSet = await (async () => {
    const phone = await fetchPhoneContext(phoneId);
    return tagsForEvent(eventType, phone, safePayload);
  })();

  // Per-event delta table — empty for unknown event types so the
  // event is still logged but the score isn't polluted.
  const deltas = deltasFor(eventType);

  return prisma.$transaction(async (tx) => {
    // 1. Append-only event log.
    const event = await tx.event.create({
      data: {
        userId,
        eventType,
        ...(phoneId ? { phoneId } : {}),
        ...(safePayload ? { payload: safePayload } : {}),
      },
    });

    // 2. Apply decay + delta per tag. Only relevant when this
    //    eventType has at least one non-zero delta.
    const updatedTags = [];
    if (Object.keys(deltas).length > 0 && tagSet.size > 0) {
      // Load the current rows we care about in one query.
      const tagsArr = Array.from(tagSet);
      const existing = await tx.behaviorScore.findMany({
        where: { userId, tag: { in: tagsArr } },
        select: { tag: true, score: true },
      });
      const currentMap = Object.fromEntries(
        existing.map((row) => [row.tag, row.score]),
      );

      // For tags with no row yet we *don't* add the brand prefix —
      // we only update tags that this event actually emits. A search
      // event never touches `category:*`, even if the score for that
      // category is 0 today.
      const newMap = applyDeltas(currentMap, deltas);

      // Upsert each updated tag individually (Postgres advisory locks
      // would be overkill — the row PK is (userId, tag) so concurrent
      // upserts are safe per-tag). We use `update + create` instead
      // of `upsert` so we don't fire a SELECT before each write.
      for (const tag of tagsArr) {
        if (!(tag in newMap)) continue;
        // The `deltas` map and the `tags` set use the same dimension
        // vocabulary but different *value* namespaces (tags are
        // "<dim>:<value>", deltas are pure dim keys). Map dim → tag
        // by the tag's leading dimension prefix.
        const dim = tag.split(":", 1)[0];
        const delta = deltas[dim];
        if (delta === undefined) continue;

        const next = newMap[tag];
        // Tag rows only exist when they've been touched before; the
        // first time a user saves a Samsung phone we INSERT a fresh
        // row rather than touching an unrelated 0-row.
        const existed = tag in currentMap;
        if (existed) {
          await tx.behaviorScore.update({
            where: { userId_tag: { userId, tag } },
            data: { score: next },
          });
        } else {
          // Only insert if there's actually a delta to apply — a
          // zero-delta brand new row would be useless clutter.
          if (next === 0) continue;
          await tx.behaviorScore.create({
            data: { userId, tag, score: next },
          });
        }
        updatedTags.push(tag);
      }
    }

    return { event, updatedTags };
  });
};

/**
 * Fetch the user's rolled-up behaviour score map. Shape:
 *   { "brand:Samsung": 4.2, "category:gaming": 7.1, ... }
 *
 * Used by `recommendService` (Step D's Final Ranking Formula) and by
 * the `GET /api/events/behavior/me` endpoint.
 */
export const loadBehaviorScores = async (userId) => {
  const rows = await prisma.behaviorScore.findMany({
    where: { userId },
    select: { tag: true, score: true },
  });
  const out = {};
  for (const row of rows) out[row.tag] = row.score;
  return out;
};

/**
 * Load the last N events for a user, newest first. Used by the
 * Profile Evolution Engine (Step F) when it asks "is this user's
 * behaviour consistent?". Returns the raw event rows — Step F will
 * decide which eventTypes count.
 */
export const loadRecentEvents = async (userId, { limit = 50 } = {}) => {
  if (!userId) throw notFound("userId required");
  return prisma.event.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 200),
  });
};

// Re-export so the controller can validate eventType against the
// single source of truth.
export { EVENT_TYPES };