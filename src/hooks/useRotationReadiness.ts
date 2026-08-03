'use client';

import { useEffect, useState } from 'react';

export interface RotationReadiness {
  rotation: string;
  coverage: number;
  mastery: number;
  weeklyProgress: Array<{
    week: number | null;
    totalCards: number;
    studiedCards: number;
    coverage: number;
  }>;
  weeklyActivity: Array<{
    date: string;
    cardsReviewed: number;
    questionsAnswered?: number;
  }>;
  conceptMastery: {
    weak: Array<{ concept: string; mastery: number; cardCount: number }>;
    unseen: Array<{ concept: string; cardCount: number }>;
  };
}

interface State {
  data: RotationReadiness | null;
  loading: boolean;
  error: string | null;
}

export function useRotationReadiness(rotation: string | null): State {
  const [state, setState] = useState<State>({
    data: null,
    loading: rotation !== null,
    error: null,
  });

  useEffect(() => {
    if (!rotation) {
      // When rotation transitions to null, clear the previous fetch result.
      // This is intentionally a synchronous setState — the React 19 linter
      // flags it because deriving the cleared state from props would be
      // cleaner, but doing so here would require restructuring the entire
      // hook around derived state and a useReducer for the fetch path.
      // The cost (one extra render on transition-to-null) is acceptable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState((s) =>
        s.data === null && !s.loading && s.error === null
          ? s
          : { data: null, loading: false, error: null }
      );
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetch(`/api/study/rotation-readiness?rotation=${encodeURIComponent(rotation)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: RotationReadiness) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: String(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [rotation]);

  return state;
}
