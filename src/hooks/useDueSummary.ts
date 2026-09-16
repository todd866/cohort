'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
};

interface DueSummaryData {
  due: number;
  daysToExam: number | null;
  examDate: string | null;
}

export function useDueSummary(rotation: string | null) {
  const { status } = useSession();
  const isLoggedIn = status === 'authenticated';

  const result = useSWR<DueSummaryData>(
    isLoggedIn && rotation ? `/api/study/due-summary?rotation=${rotation}` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 30000 },
  );

  return { ...result, revalidate: result.mutate };
}
