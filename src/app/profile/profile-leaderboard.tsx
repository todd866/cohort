'use client';

import { useCallback, useState } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import { HANDLE_MAX, LEADERBOARD_WINDOW_DAYS, type LeaderboardRow } from '@/lib/leaderboard/leaderboard-lib';

/**
 * The opt-in leaderboard, on the profile.
 *
 * Not joined: one line saying what joining means, a name box, a join button.
 * Joined: the board with your row marked, and a leave button. Nobody who has not joined
 * sees any other learner — except an admin, who gets the everyone view the
 * server grants (`viewAll`), with a "not joined" mark on the learners who
 * never opted in. No animation anywhere: this is a tens-per-day
 * surface at most, and the motion rule's default is none.
 */
export interface BoardResponse {
  handle: string | null;
  rows: LeaderboardRow[];
  me: LeaderboardRow | null;
  joinedCount: number;
  viewAll?: boolean;
}

interface Props {
  joined: boolean;
  handle: string | null;
  /**
   * Admin only, decided on the server. The board then lists every registered
   * learner, and a learner who has not opted in is shown by their own name (or
   * the local part of their email, where no name is set) and marked as such.
   * Nobody else's view changes, and this component never decides it for
   * itself: it renders what the server allowed.
   */
  viewAll?: boolean;
  /**
   * The board as the server rendered it. This component does not fetch on
   * mount: a missing board used to paint the heading, then the rows, after a
   * second request for data the page already loaded. Join and leave still
   * go through the API, because those are the learner's own actions.
   */
  initialBoard?: BoardResponse | null;
  /** The server read failed. Shown in place, with no browser retry. */
  boardUnavailable?: boolean;
}

const box = 'mb-4 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 py-3';
const button = 'rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm font-medium text-[var(--md-on-primary)] disabled:opacity-50';
const quiet = 'text-sm text-[var(--md-on-surface-variant)]';

const windowLine = `Last ${LEADERBOARD_WINDOW_DAYS} days. Others see only this name.`;

export function ProfileLeaderboard({
  joined: initialJoined,
  handle: initialHandle,
  viewAll = false,
  initialBoard = null,
  boardUnavailable = false,
}: Props) {
  const [joined, setJoined] = useState(initialJoined);
  const [handle, setHandle] = useState(initialHandle ?? '');
  const [board, setBoard] = useState<BoardResponse | null>(initialBoard);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithDeadline('/api/leaderboard', { cache: 'no-store' }, CLIENT_FETCH_DEADLINE_MS);
      if (res.status === 403) { setJoined(false); setBoard(null); return false; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBoard(await res.json() as BoardResponse);
      return true;
    } catch {
      setError('The board did not load; try again in a moment.');
      return false;
    }
  }, []);

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithDeadline('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      }, CLIENT_FETCH_DEADLINE_MS);
      const body = await res.json().catch(() => ({})) as { error?: string; handle?: string };
      if (!res.ok) { setError(body.error ?? 'That did not work; try again.'); return; }
      setHandle(body.handle ?? handle);
      await load();
      setJoined(true);
    } catch {
      setError('That did not send; check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithDeadline('/api/leaderboard', { method: 'DELETE' }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJoined(false);
      if (viewAll) await load(); else setBoard(null);
    } catch {
      setError('Could not leave just now; try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!joined && !viewAll) {
    return (
      <section className={box} aria-labelledby="leaderboard-heading" data-testid="leaderboard-join">
        <h2 id="leaderboard-heading" className="text-base font-semibold text-[var(--md-on-surface)]">Leaderboard</h2>
        <p className={`${quiet} mt-1`}>{windowLine}</p>
        <form onSubmit={join} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="leaderboard-handle" className="sr-only">Name to show on the leaderboard</label>
          <input
            id="leaderboard-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={HANDLE_MAX}
            placeholder="Name to show"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1.5 text-sm text-[var(--md-on-surface)]"
          />
          <button type="submit" className={button} disabled={busy || handle.trim().length === 0}>
            {busy ? 'Joining…' : 'Join leaderboard'}
          </button>
        </form>
        {error && <p role="alert" className="mt-2 text-sm text-[var(--md-error)]">{error}</p>}
      </section>
    );
  }

  return (
    <section className={box} aria-labelledby="leaderboard-heading" data-testid="leaderboard-board">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="leaderboard-heading" className="text-base font-semibold text-[var(--md-on-surface)]">Leaderboard</h2>
        {joined && (
          <button type="button" onClick={leave} disabled={busy} className={`${quiet} underline disabled:opacity-50`}>
            Leave
          </button>
        )}
      </div>
      <p className={`${quiet} mt-1`}>{windowLine}</p>
      {viewAll && (
        <p className={`${quiet} mt-1`} data-testid="leaderboard-view-all">
          Admin: every learner.
        </p>
      )}
      {boardUnavailable && !board && (
        <p className="mt-2 min-h-40 text-sm text-[var(--md-on-surface-variant)]">Couldn&apos;t load</p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--md-error)]">{error}</p>}
      {board && board.rows.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead className={quiet}>
            <tr>
              <th scope="col" className="py-1 text-left font-normal">#</th>
              <th scope="col" className="py-1 text-left font-normal">Name</th>
              <th scope="col" className="py-1 text-right font-normal">{LEADERBOARD_WINDOW_DAYS}d</th>
              <th scope="col" className="py-1 text-right font-normal">All time</th>
              <th scope="col" className="py-1 text-right font-normal">Streak</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((row, index) => (
              <tr
                key={`${row.rank}-${row.handle}-${index}`}
                data-testid={row.isMe ? 'leaderboard-me' : undefined}
                className={row.isMe ? 'font-medium text-[var(--md-primary)]' : 'text-[var(--md-on-surface)]'}
              >
                <td className="py-1">{row.rank}</td>
                <td className="py-1">
                  {row.handle}
                  {!row.isJoined && (
                    <span className={`ml-1.5 text-xs ${quiet}`} data-testid="leaderboard-not-joined">
                      not joined
                    </span>
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">{row.windowReviews}</td>
                <td className="py-1 text-right tabular-nums">{row.allTimeReviews}</td>
                <td className="py-1 text-right tabular-nums">{row.streakDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!joined && (
        <form onSubmit={join} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="leaderboard-handle" className="sr-only">Name to show on the leaderboard</label>
          <input
            id="leaderboard-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={HANDLE_MAX}
            placeholder="Name to show"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1.5 text-sm text-[var(--md-on-surface)]"
          />
          <button type="submit" className={button} disabled={busy || handle.trim().length === 0}>
            {busy ? 'Joining…' : 'Join leaderboard'}
          </button>
        </form>
      )}
    </section>
  );
}
