# Subtitle Timing Studio

Local workbench for timed cues with injectable alignment sessions.

Run `npm install`, then `npm run dev` (API on :4174, Vite on :4173).

## Alignment review model

- `POST /api/tracks/:id/alignment-sessions` starts an alignment. The session
  pins the current track **revision** and snapshots the cues; the aligner
  (`default`, or any injected factory) emits suggestions asynchronously,
  possibly in several batches and out of order.
- Suggestions carry `cueId`, the aligner's `baseline` timing, `proposed`
  timing and `confidence`.
- `GET /api/alignment-sessions/:sid/events?after=<seq>` long-polls and
  resumes from the last delivered sequence number. Reconnects never
  re-apply old events.
- The client auto-applies a suggestion only while the cue still matches its
  baseline (or the client's previous auto-applied proposal). User edits,
  accepted and rejected cues are never overwritten; newer corrections for a
  decided cue surface as conflicts.
- `POST .../accept` and `.../reject` require an `idempotencyKey`; retrying
  the same key replays the first decision. Accepts may carry a tweaked
  `proposed` range.
- A completed stream stays in a review window for decisions.
  `POST .../cancel` is terminal: late aligner emissions are appended as
  `ignored` events, never as suggestions.
- `DELETE /api/tracks/:id` mid-session makes session endpoints respond
  `410 Gone`.

Tests: `npm test` — server API races (out-of-order delivery, repeated
corrections, partial accept with idempotency replay, cancel/complete races,
track deletion) plus the pure client merge engine (user-edit protection,
unsaved tweaks surviving filter changes, ignore rollback, stable cue order).
