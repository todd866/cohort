'use client';

import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

interface ReviewModeContextValue {
  enabled: boolean;
  rotation?: string;
  week?: number;
  topics?: string[];
}

const ReviewModeContext = createContext<ReviewModeContextValue>({
  enabled: false,
});

export function ReviewModeProvider({
  enabled,
  rotation,
  week,
  topics,
  children,
}: ReviewModeContextValue & { children: ReactNode }) {
  return (
    <ReviewModeContext.Provider value={{ enabled, rotation, week, topics }}>
      {children}
    </ReviewModeContext.Provider>
  );
}

export function useReviewMode(): ReviewModeContextValue {
  return useContext(ReviewModeContext);
}
