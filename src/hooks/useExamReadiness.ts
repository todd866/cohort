'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
};

export interface ExamReadinessData {
  rotation: string;
  examDate: string | null;
  daysToExam: number | null;
  summary: {
    totalCards: number;
    reviewedCards: number;
    neverReviewed: number;
    atRiskCards: number;
    overallCurrentStrength: number;
    overallExamDayStrength: number;
    projectedDecay: number;
    requiredDailyReviews: number;
    dailyProgress: number;
    examPrediction: number;
    todayReviewed: number;
  };
  weeklyReadiness?: Array<{
    week: number;
    cardCount: number;
    avgCurrentStrength: number;
    avgExamDayStrength: number;
    atRiskCount: number;
  }>;
  topAtRisk?: Array<{
    cardId: string;
    front: string;
    week: number;
    currentStrength: number;
    examDayStrength: number;
    decayRisk: number;
  }>;
}

export function useExamReadiness(rotation: string | null) {
  const { status } = useSession();
  const isLoggedIn = status === 'authenticated';

  const result = useSWR<ExamReadinessData>(
    isLoggedIn && rotation ? `/api/study/exam-readiness?rotation=${rotation}` : null,
    fetcher,
    { revalidateOnFocus: true, refreshInterval: 60000, dedupingInterval: 30000 },
  );

  return { ...result, revalidate: result.mutate };
}
