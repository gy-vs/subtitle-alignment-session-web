# Subtitle Timing Studio

Local workbench for timed cues.

Run `npm install`, then `npm run dev`.

## Alignment suggestion review (`src/client/review/`)

Framework-agnostic engine for reviewing timing suggestions streamed from an
injectable aligner:

- `SuggestionReviewSession` is opened from a `TrackSnapshot` (track id +
  pinned revision + cues in display order). Events carrying a different
  revision are ignored.
- Suggestions arrive in batches as events (`eventId`, `seq`, revision,
  items with cue id / baseline / suggested times / confidence). Events are
  deduped by `eventId`; per cue the highest `seq` wins, so out-of-order and
  repeated corrections fold deterministically.
- A suggestion auto-applies only while its baseline still matches the cue
  and the user has not edited the cue; anything else becomes a conflict.
  User decisions are never overwritten — a newer correction reopens a
  decided cue as a conflict.
- `accept` / `reject` use per-decision idempotency keys and an outbox that
  retries delivery through the injectable `DecisionSink`.
- `disconnect()` / `reconnect()` resume the event stream from the last
  processed event. After `cancel()` (or track deletion via
  `notifyTrackDeleted()`), late suggestions are only recorded as `ignored`;
  cancel also reverts unconfirmed auto-applied cues.
- `list()` is always in stable cue order; `setFilter()` only narrows
  `visible()` and never affects event folding or unsaved fine-tune drafts.

Bind to React with `useReviewItems(session)` from `src/client/review/react.ts`.
See `test/review-session.test.ts` for the covered concurrency scenarios.
