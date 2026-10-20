'use client';

import { createContext, useContext } from 'react';
import type { AppliedStatsLayout } from '@/lib/stats/stats-layout';

export const StatsLayoutContext = createContext<{
  layout: AppliedStatsLayout;
  save: (next: AppliedStatsLayout) => void;
} | null>(null);

export function useStatsLayout() {
  return useContext(StatsLayoutContext);
}
