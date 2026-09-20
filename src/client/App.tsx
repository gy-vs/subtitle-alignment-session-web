import {useEffect, useMemo, useState} from 'react';
import {Check, Eraser, FlaskConical, Play, Save, ShieldAlert, SlidersHorizontal, X} from 'lucide-react';
import type {Cue, SuggestionStatus} from '../shared/types';
import {entryCounts, selectEntries, type EntryFilter} from './alignment/editor';
import {useAlignmentSession} from './alignment/useAlignmentSession';

type Summary = {id: string; name: string; revision: number};

function formatTime(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const value = Math.abs(ms);
  const seconds = Math.floor(value / 1000);
  const millis = value % 1000;
  return `${sign}${seconds}.${String(millis).padStart(3, '0')}s`;
}

const FILTERS: Array<{key: EntryFilter; label: string}> = [
  {key: 'all', label: 'All'},
  {key: 'pending', label: 'Auto-applied'},
  {key: 'conflict', label: 'Conflicts'},
  {key: 'accepted', label: 'Accepted'},
  {key: 'rejected', label: 'Rejected'},
  {key: 'ignored', label: 'Ignored'},
];

const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: 'Auto-applied',
  conflict: 'Conflict',
  accepted: 'Accepted',
  rejected: 'Rejected',
  ignored: 'Ignored (late)',
};

function NumberField({value, onCommit, ariaLabel}: {value: number; onCommit: (next: number) => void; ariaLabel: string}) {
  return (
    <input
      aria-label={ariaLabel}
      className="time-input"
      type="number"
      step={10}
      value={value}
      onChange={event => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onCommit(next);
      }}
    />
  );
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [filter, setFilter] = useState<EntryFilter>('all');
  const api = useAlignmentSession();
  const {state} = api;

  useEffect(() => {
    fetch('/api/tracks')
      .then(r => r.json())
      .then(setItems);
  }, []);

  useEffect(() => {
    void api.loadTrack('alpha');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The filter is derived view state: switching it never re-merges entries
  // and never clears an unsaved tweak.
  const rows = useMemo(() => selectEntries(state, filter), [state, filter]);
  const counts = useMemo(() => entryCounts(state), [state]);
  const entryByCue = state.entries;
  const running = state.session.phase === 'running';
  // A completed stream stays reviewable; only cancellation locks decisions.
  const canDecide = state.session.phase !== null && state.session.phase !== 'cancelled';

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Subtitle Timing Studio</strong>
        <small>Aligner review workbench</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Tracks</h2>
          <div className="list">
            {items.map(item => (
              <button
                key={item.id}
                className={item.id === state.trackId ? 'active' : ''}
                onClick={() => void api.loadTrack(item.id)}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={() => void api.startAlignment('default')} disabled={running || !state.trackId}>
              <Play size={15} />
              Align
            </button>
            <button onClick={() => void api.cancelSession()} disabled={!running}>
              <X size={15} />
              Cancel session
            </button>
            <button onClick={() => void api.saveTrack()} disabled={!state.trackId}>
              <Save size={15} />
              Save cues
            </button>
            <span className="pill">
              {state.session.phase ? `session ${state.session.phase} · rev ${state.session.revision}` : `rev ${state.revision ?? '–'}`}
              {state.session.done ? ' · review window' : running ? ' · streaming' : ''}
            </span>
            <span>{api.busy ?? ''}</span>
          </div>

          {api.notice && (
            <div className="notice" role="status">
              {api.notice}
              <button aria-label="Dismiss notice" onClick={api.clearNotice}>
                <X size={13} />
              </button>
            </div>
          )}

          <table className="cue-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Text</th>
                <th>Start</th>
                <th>End</th>
                <th>Suggestion</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.cues.map((cue, index) => {
                const entry = entryByCue[cue.id];
                const protectedByUser = !!state.userEdited[cue.id];
                return (
                  <tr key={cue.id} className={entry ? `cue-${entry.status}` : undefined}>
                    <td className="cue-index">{index + 1}</td>
                    <td className="cue-text">{cue.text}</td>
                    <td>
                      <NumberField ariaLabel={`${cue.id} start`} value={cue.start} onCommit={next => api.editCue(cue.id, next, cue.end)} />
                    </td>
                    <td>
                      <NumberField ariaLabel={`${cue.id} end`} value={cue.end} onCommit={next => api.editCue(cue.id, cue.start, next)} />
                    </td>
                    <td className="suggestion-cell">
                      {entry ? (
                        <>
                          <span className={`status status-${entry.status}`}>
                            {entry.status === 'conflict' && <ShieldAlert size={12} />}
                            {STATUS_LABEL[entry.status]}
                            {protectedByUser && entry.status === 'conflict' && ' · your edit kept'}
                          </span>
                          <small>
                            {entry.conflictReason === 'unknown-cue' ? 'cue not on this track' : `Δ ${formatTime(entry.proposed.start - cue.start)} → ${formatTime(entry.proposed.start)}`}
                            {' · '}
                            conf {Math.round(entry.confidence * 100)}%
                            {entry.tweaked && ' · tweaked'}
                            {entry.eventSeqs.length > 1 && ` · ${entry.eventSeqs.length} revisions (#${entry.seq})`}
                          </small>
                          {entry.status === 'conflict' && (
                            <small className="conflict-detail">
                              baseline {formatTime(entry.baseline.start)}–{formatTime(entry.baseline.end)}
                              <label className="tweak-row">
                                <SlidersHorizontal size={12} /> tweak
                                <NumberField ariaLabel={`${cue.id} tweak start`} value={entry.proposed.start} onCommit={next => api.tweak(cue.id, next, entry.proposed.end)} />
                                <NumberField ariaLabel={`${cue.id} tweak end`} value={entry.proposed.end} onCommit={next => api.tweak(cue.id, entry.proposed.start, next)} />
                              </label>
                              {entry.tweaked && (
                                <button className="link-button" onClick={() => api.discardTweak(cue.id)}>
                                  <Eraser size={12} /> discard tweak
                                </button>
                              )}
                            </small>
                          )}
                        </>
                      ) : (
                        <small className="muted">—</small>
                      )}
                    </td>
                    <td className="actions-cell">
                      {entry && (entry.status === 'pending' || entry.status === 'conflict') && (
                        <>
                          <button className="accept" onClick={() => void api.accept(entry)} disabled={!canDecide || api.busy === 'accepting'}>
                            <Check size={13} /> Accept
                          </button>
                          <button onClick={() => void api.reject(entry)} disabled={!canDecide || api.busy === 'rejecting'}>
                            <X size={13} /> Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h3 className="filter-heading">Review queue</h3>
          <div className="filters" role="tablist" aria-label="Filter suggestions">
            {FILTERS.map(({key, label}) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? 'filter active' : 'filter'}
                onClick={() => setFilter(key)}
              >
                {label} <span className="count">{counts[key]}</span>
              </button>
            ))}
          </div>
          <ol className="review-queue">
            {rows.map(entry => {
              const cue: Cue | undefined = state.cues.find(item => item.id === entry.cueId);
              return (
                <li key={entry.cueId} className={`queue-item queue-${entry.status}`}>
                  <span className={`status status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                  <strong>{entry.cueId}</strong>
                  <small>{cue?.text ?? '(cue missing from track)'}</small>
                  <small>
                    {formatTime(entry.proposed.start)}–{formatTime(entry.proposed.end)} · {Math.round(entry.confidence * 100)}% · seq #{entry.seq}
                    {entry.tweaked && ' · unsaved tweak'}
                  </small>
                </li>
              );
            })}
            {rows.length === 0 && <li className="muted">No suggestions in this view.</li>}
          </ol>
        </section>

        <aside className="pane">
          <h2>Inspection</h2>
          <span className="pill">{state.trackId ?? 'no track'}</span>
          <pre>
            {JSON.stringify(
              {
                track: state.trackId,
                revision: state.revision,
                session: state.session,
                userEdited: Object.keys(state.userEdited).filter(id => state.userEdited[id]),
                entries: Object.values(state.entries).map(({cueId, status, seq, eventSeqs, tweaked, conflictReason}) => ({
                  cueId,
                  status,
                  conflictReason,
                  seq,
                  revisions: eventSeqs,
                  tweaked,
                })),
              },
              null,
              2,
            )}
          </pre>
        </aside>
      </section>
    </main>
  );
}
