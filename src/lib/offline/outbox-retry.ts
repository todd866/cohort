/**
 * Retry a non-empty outbox on a timer, with backoff.
 *
 * The flush used to run only on mount, the browser 'online' event and the tab
 * becoming visible, and it stops after three transport failures in a row. On
 * patchy signal navigator.onLine stays true, so no 'online' event fires and a
 * backlog waited until the app was backgrounded and reopened: on 12 Oct 2026
 * a learner's queue grew to dozens of answers that way. This keeps trying while
 * anything is queued and the page is visible, and goes quiet when the queue is
 * empty. A shrinking queue means the link is back, so the delay resets.
 */
export const OUTBOX_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface OutboxRetry {
  /** Call when the queue may have changed; schedules a retry if one is needed. */
  poke(): void;
  stop(): void;
}

export function createOutboxRetry({ size, flush, visible }: {
  size: () => number;
  flush: () => Promise<void>;
  visible: () => boolean;
}): OutboxRetry {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastSize = size();
  let stopped = false;

  const schedule = () => {
    if (stopped || timer !== null) return;
    if (size() === 0 || !visible()) return;
    const delay = OUTBOX_RETRY_DELAYS_MS[Math.min(attempt, OUTBOX_RETRY_DELAYS_MS.length - 1)];
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || size() === 0 || !visible()) return;
      attempt += 1;
      try {
        await flush();
      } catch {
        // The queue keeps every write; the next attempt tries again.
      }
      const now = size();
      if (now < lastSize) attempt = 0;
      lastSize = now;
      schedule();
    }, delay);
  };

  return {
    poke() {
      const now = size();
      if (now === 0) {
        attempt = 0;
      } else if (now < lastSize) {
        attempt = 0;
        if (timer !== null) { clearTimeout(timer); timer = null; }
      }
      lastSize = now;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
