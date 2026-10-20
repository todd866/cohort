/**
 * Serialises and coalesces saves of a whole value (a layout): at most one
 * request in flight, and only the latest value waiting behind it. A slower
 * older request can therefore never land after a newer one, and a burst of
 * edits sends the first and the last, not every step.
 */
export interface LatestSaver<T> {
  save(value: T): void;
  /** Resolves once nothing is in flight or pending (tests and unmount). */
  idle(): Promise<void>;
}

export function createLatestSaver<T>(
  send: (value: T) => Promise<boolean>,
  onResult: (ok: boolean) => void,
): LatestSaver<T> {
  let inFlight: Promise<void> | null = null;
  let pending: { value: T } | null = null;

  const run = (value: T): Promise<void> => {
    const attempt = send(value).then((ok) => ok, () => false).then((ok) => {
      // Report only the outcome of the newest value; an older success is moot.
      if (!pending) onResult(ok);
      else if (!ok) onResult(false);
    });
    inFlight = attempt.then(() => {
      inFlight = null;
      if (pending) {
        const next = pending.value;
        pending = null;
        return run(next);
      }
      return undefined;
    });
    return inFlight;
  };

  return {
    save(value: T) {
      if (inFlight) pending = { value };
      else void run(value);
    },
    async idle() {
      while (inFlight) await inFlight;
    },
  };
}
