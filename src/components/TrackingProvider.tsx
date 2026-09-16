'use client';

import { usePageTracking } from '@/hooks/useTracking';

export function TrackingProvider({ children }: { children: React.ReactNode }) {
  usePageTracking();
  return <>{children}</>;
}
