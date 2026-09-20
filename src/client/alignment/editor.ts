import type {Cue, SessionEvent, SessionPhase, Suggestion, SuggestionStatus, TimeRange} from '../../shared/types';

/**
 * Pure merge engine for an alignment session.
 *
 * Rules implemented here:
 * - Suggestions whose baseline still matches the live cue auto-apply; every
 *   other suggestion is parked in `conflict`.
 * - Cues the user edited (or already accepted) are never overwritten by a
 *   later suggestion; the newer correction becomes a conflict instead.
 * - Events may arrive out of order and in batches: folding is a function of
 *   sequence numbers only, never of arrival order.
 * - Filtering is a view-only concern; it never re-merges entries and never
 *   discards unsaved tweaks.
 */

export type EntryFilter = 'all' | SuggestionStatus;

export interface SuggestionEntry {
  cueId: string;
  status: SuggestionStatus;
  conflictReason?: 'baseline-mismatch' | 'user-edited' | 'unknown-cue' | 'superseded-decision';
  confidence: number;
  reason?: string;
  seq: number;
  /** Every event seq that contributed to this entry, oldest first. */
  eventSeqs: number[];
  /** Baseline carried by the newest suggestion. */
  baseline: TimeRange;
  /** Current proposal; an unsaved tweak mutates this until accepted. */
  proposed: TimeRange;
  /** Server proposal before any local tweak (used by "discard tweak"). */
  originalProposed: TimeRange;
  tweaked: boolean;
  /** Set while the cue currently holds an auto-applied proposal. */
  lastApplied?: {seq: number; proposed: TimeRange};
  /** Seq this entry was decided on, once accepted/rejected. */
  decidedSeq?: number;
}

export interface SessionState {
  id: string | null;
  revision: number | null;
  phase: SessionPhase | null;
  /** Highest event seq observed locally (resume cursor). */
  lastSeen: number;
  /** Server says no more events will ever arrive. */
  done: boolean;
}

export interface EditorState {
  trackId: string | null;
  name: string;
  revision: number | null;
  cues: Cue[];
  /** Loading-time timing per cue, used to restore a cue after rejection. */
  loadedTiming: Record<string, TimeRange>;
  /** Cues touched by the user (manual edit, tweak, accept). Protected. */
  userEdited: Record<string, boolean>;
  entries: Record<string, SuggestionEntry>;
  session: SessionState;
  deleted: boolean;
}

export type EditorAction =
  | {type: 'track-loaded'; trackId: string; name: string; revision: number; cues: Cue[]}
  | {type: 'cue-edited'; cueId: string; range: TimeRange}
  | {type: 'session-started'; id: string; revision: number; cues: Cue[]}
  | {type: 'events'; events: SessionEvent[]; phase: SessionPhase; lastSeq: number; done: boolean}
  | {type: 'accepted'; cueId: string; seq: number; cue: Cue}
  | {type: 'rejected'; cueId: string; seq: number}
  | {type: 'tweak'; cueId: string; range: TimeRange}
  | {type: 'discard-tweak'; cueId: string}
  | {type: 'saved'; revision: number; cues: Cue[]}
  | {type: 'track-deleted'};

export function initialEditorState(): EditorState {
  return {
    trackId: null,
    name: '',
    revision: null,
    cues: [],
    loadedTiming: {},
    userEdited: {},
    entries: {},
    session: {id: null, revision: null, phase: null, lastSeen: -1, done: false},
    deleted: false,
  };
}

function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.start === b.start && a.end === b.end;
}

function cueById(state: EditorState, cueId: string): Cue | undefined {
  return state.cues.find(cue => cue.id === cueId);
}

function replaceCue(cues: Cue[], cueId: string, range: TimeRange): Cue[] {
  return cues.map(cue => (cue.id === cueId ? {...cue, ...range} : cue));
}

/**
 * Decide whether a fresh suggestion for an existing entry can auto-apply.
 * Besides an exact baseline match we accept the case where the cue still
 * holds our previous auto-applied proposal (multi-batch correction chains).
 */
function canAutoApply(state: EditorState, entry: SuggestionEntry | undefined, cue: Cue, suggestion: Suggestion): boolean {
  if (state.userEdited[cue.id]) return false;
  if (sameRange(cue, suggestion.baseline)) return true;
  return !!entry?.lastApplied && sameRange(cue, entry.lastApplied.proposed);
}

function foldSuggestion(state: EditorState, event: SessionEvent & {type: 'suggestion'}): EditorState {
  const cue = cueById(state, cueEventId(event));
  const cueId = event.cueId;
  const previous = state.entries[cueId];
  const eventSeqs = [...(previous?.eventSeqs ?? []), event.seq];

  if (previous && (previous.status === 'accepted' || previous.status === 'rejected')) {
    // A terminal user decision stands; the late correction is surfaced as a
    // conflict the user may inspect, never silently applied.
    const entry: SuggestionEntry = {
      ...previous,
      status: 'conflict',
      conflictReason: 'superseded-decision',
      confidence: event.confidence,
      reason: event.reason,
      seq: event.seq,
      eventSeqs,
      baseline: event.baseline,
      proposed: event.proposed,
      originalProposed: event.proposed,
      tweaked: false,
      lastApplied: undefined,
    };
    return {...state, entries: {...state.entries, [cueId]: entry}};
  }

  if (!cue) {
    const entry: SuggestionEntry = {
      cueId,
      status: 'conflict',
      conflictReason: 'unknown-cue',
      confidence: event.confidence,
      reason: event.reason,
      seq: event.seq,
      eventSeqs,
      baseline: event.baseline,
      proposed: event.proposed,
      originalProposed: event.proposed,
      tweaked: false,
    };
    return {...state, entries: {...state.entries, [cueId]: entry}};
  }

  const status: SuggestionStatus = canAutoApply(state, previous, cue, event) ? 'pending' : 'conflict';
  const entry: SuggestionEntry = {
    cueId,
    status,
    conflictReason: status === 'conflict' ? (state.userEdited[cueId] ? 'user-edited' : 'baseline-mismatch') : undefined,
    confidence: event.confidence,
    reason: event.reason,
    seq: event.seq,
    eventSeqs,
    baseline: event.baseline,
    proposed: event.proposed,
    originalProposed: event.proposed,
    tweaked: false,
    lastApplied: status === 'pending' ? {seq: event.seq, proposed: event.proposed} : undefined,
  };

  const cues = status === 'pending' ? replaceCue(state.cues, cueId, event.proposed) : state.cues;
  return {...state, cues, entries: {...state.entries, [cueId]: entry}};
}

function cueEventId(event: {cueId: string}): string {
  return event.cueId;
}

function foldIgnored(state: EditorState, event: SessionEvent & {type: 'ignored'}): EditorState {
  const cueId = event.cueId;
  const previous = state.entries[cueId];
  // A user decision is never downgraded; everything else becomes a record.
  if (previous && (previous.status === 'accepted' || previous.status === 'rejected')) return state;

  let cues = state.cues;
  if (previous?.status === 'pending' && previous.lastApplied) {
    // Roll back the auto-applied timing of a suggestion the server ignored.
    const cue = cueById(state, cueId);
    if (cue && !state.userEdited[cueId]) cues = replaceCue(cues, cueId, previous.baseline);
  }

  const entry: SuggestionEntry = previous
    ? {
        ...previous,
        status: 'ignored' as const,
        conflictReason: undefined,
        seq: event.seq,
        eventSeqs: [...previous.eventSeqs, event.seq],
        baseline: event.suggestion.baseline,
        proposed: event.suggestion.proposed,
        originalProposed: event.suggestion.proposed,
        tweaked: false,
        lastApplied: undefined,
      }
    : {
        cueId,
        status: 'ignored' as const,
        confidence: event.suggestion.confidence,
        reason: event.suggestion.reason,
        seq: event.seq,
        eventSeqs: [event.seq],
        baseline: event.suggestion.baseline,
        proposed: event.suggestion.proposed,
        originalProposed: event.suggestion.proposed,
        tweaked: false,
      };
  return {...state, cues, entries: {...state.entries, [cueId]: entry}};
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'track-loaded': {
      const loadedTiming: Record<string, TimeRange> = {};
      for (const cue of action.cues) loadedTiming[cue.id] = {start: cue.start, end: cue.end};
      return {
        ...initialEditorState(),
        trackId: action.trackId,
        name: action.name,
        revision: action.revision,
        cues: action.cues.map(cue => ({...cue})),
        loadedTiming,
      };
    }

    case 'cue-edited': {
      if (!state.entries[action.cueId] && !state.session.id) {
        return {...state, cues: replaceCue(state.cues, action.cueId, action.range)};
      }
      const userEdited = {...state.userEdited, [action.cueId]: true};
      let entries = state.entries;
      const previous = state.entries[action.cueId];
      if (previous && previous.status !== 'accepted' && previous.status !== 'rejected' && previous.status !== 'ignored') {
        entries = {
          ...entries,
          [action.cueId]: {
            ...previous,
            status: 'conflict',
            conflictReason: 'user-edited',
            lastApplied: undefined,
          },
        };
      }
      return {...state, cues: replaceCue(state.cues, action.cueId, action.range), userEdited, entries};
    }

    case 'session-started': {
      // Timing the user changed before the session started must be protected
      // even though the aligner computed baselines from the saved snapshot.
      const userEdited = {...state.userEdited};
      for (const cue of state.cues) {
        const loaded = state.loadedTiming[cue.id];
        if (loaded && !sameRange(loaded, cue)) userEdited[cue.id] = true;
      }
      return {
        ...state,
        userEdited,
        session: {id: action.id, revision: action.revision, phase: 'running', lastSeen: -1, done: false},
      };
    }

    case 'events': {
      // Merge by sequence number regardless of the order the batch arrived in.
      const ordered = [...action.events].sort((a, b) => a.seq - b.seq);
      let next = state;
      let lastSeen = state.session.lastSeen;
      for (const event of ordered) {
        if (event.seq <= state.session.lastSeen) continue; // resume duplicate
        if (event.type === 'suggestion') next = foldSuggestion(next, event);
        else if (event.type === 'ignored') next = foldIgnored(next, event);
        lastSeen = Math.max(lastSeen, event.seq);
      }
      lastSeen = Math.max(lastSeen, action.lastSeq);
      // Phase is monotonic: running -> cancelled | completed.
      const phaseOrder: SessionPhase[] = ['running', 'cancelled', 'completed'];
      const current = next.session.phase ?? 'running';
      const phase = phaseOrder.indexOf(action.phase) >= phaseOrder.indexOf(current) ? action.phase : current;
      return {
        ...next,
        session: {
          ...next.session,
          phase,
          lastSeen,
          done: action.done,
        },
      };
    }

    case 'accepted': {
      const previous = state.entries[action.cueId];
      const entry: SuggestionEntry | undefined = previous
        ? {
            ...previous,
            status: 'accepted',
            conflictReason: undefined,
            decidedSeq: action.seq,
            lastApplied: undefined,
            tweaked: false,
            originalProposed: previous.proposed,
          }
        : undefined;
      const cues = state.cues.some(c => c.id === action.cue.id)
        ? state.cues.map(c => (c.id === action.cue.id ? {...action.cue} : c))
        : [...state.cues, {...action.cue}];
      return {
        ...state,
        cues,
        userEdited: {...state.userEdited, [action.cueId]: true},
        entries: entry ? {...state.entries, [action.cueId]: entry} : state.entries,
      };
    }

    case 'rejected': {
      const previous = state.entries[action.cueId];
      if (!previous) return state;
      const restore = state.loadedTiming[action.cueId] ?? previous.baseline;
      // Restore the cue unless the user edited it after the suggestion landed.
      const cue = cueById(state, action.cueId);
      const cues = cue && !state.userEdited[action.cueId] ? replaceCue(state.cues, action.cueId, restore) : state.cues;
      const entry: SuggestionEntry = {
        ...previous,
        status: 'rejected',
        conflictReason: undefined,
        decidedSeq: action.seq,
        lastApplied: undefined,
        tweaked: false,
      };
      return {...state, cues, entries: {...state.entries, [action.cueId]: entry}};
    }

    case 'tweak': {
      const previous = state.entries[action.cueId];
      if (!previous || previous.status === 'accepted' || previous.status === 'rejected' || previous.status === 'ignored') {
        return state;
      }
      const entry: SuggestionEntry = {
        ...previous,
        proposed: action.range,
        tweaked: true,
        status: 'conflict',
        conflictReason: previous.status === 'pending' ? 'user-edited' : previous.conflictReason,
        lastApplied: undefined,
      };
      return {
        ...state,
        cues: replaceCue(state.cues, action.cueId, action.range),
        userEdited: {...state.userEdited, [action.cueId]: true},
        entries: {...state.entries, [action.cueId]: entry},
      };
    }

    case 'discard-tweak': {
      const previous = state.entries[action.cueId];
      if (!previous || !previous.tweaked) return state;
      const proposed = previous.originalProposed;
      // Revert to the server proposal; if the baseline still matches it can
      // become an auto-applied pending suggestion again.
      const cue = cueById(state, action.cueId);
      const matches = cue && sameRange(previous.baseline, state.loadedTiming[action.cueId] ?? previous.baseline);
      const status: SuggestionStatus = matches ? 'pending' : 'conflict';
      const userEdited = {...state.userEdited};
      delete userEdited[action.cueId];
      const entry: SuggestionEntry = {
        ...previous,
        proposed,
        tweaked: false,
        status,
        conflictReason: status === 'conflict' ? 'baseline-mismatch' : undefined,
        lastApplied: status === 'pending' ? {seq: previous.seq, proposed} : undefined,
      };
      const cues = cue ? replaceCue(state.cues, action.cueId, proposed) : state.cues;
      return {...state, cues, userEdited, entries: {...state.entries, [action.cueId]: entry}};
    }

    case 'saved': {
      const loadedTiming: Record<string, TimeRange> = {};
      for (const cue of action.cues) loadedTiming[cue.id] = {start: cue.start, end: cue.end};
      return {...state, revision: action.revision, cues: action.cues.map(c => ({...c})), loadedTiming};
    }

    case 'track-deleted':
      return {...initialEditorState(), deleted: true};

    default:
      return state;
  }
}

/** Stable cue-ordered entries; filtering only hides rows, never merges them. */
export function selectEntries(state: EditorState, filter: EntryFilter): SuggestionEntry[] {
  const order = new Map(state.cues.map((cue, index) => [cue.id, index]));
  const rows = Object.values(state.entries).sort((a, b) => {
    const ai = order.get(a.cueId);
    const bi = order.get(b.cueId);
    if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.cueId < b.cueId ? -1 : a.cueId > b.cueId ? 1 : 0;
  });
  return filter === 'all' ? rows : rows.filter(entry => entry.status === filter);
}

export function entryCounts(state: EditorState): Record<EntryFilter, number> {
  const counts: Record<EntryFilter, number> = {
    all: Object.keys(state.entries).length,
    pending: 0,
    conflict: 0,
    accepted: 0,
    rejected: 0,
    ignored: 0,
  };
  for (const entry of Object.values(state.entries)) counts[entry.status] += 1;
  return counts;
}

/** Deterministic client-side idempotency key, unique per decision revision. */
export function decisionKey(sessionId: string, cueId: string, seq: number, kind: 'accept' | 'reject'): string {
  return `${sessionId}:${kind}:${cueId}:${seq}`;
}
