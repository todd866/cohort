'use client';
import { useSyncExternalStore } from 'react';
import { getPendingForKey, subscribeOutbox } from '@/lib/outbox';

export function useFlagPending(key: string): 'pending' | 'blocked' | null {
  return useSyncExternalStore(
    subscribeOutbox,
    () => getPendingForKey(key),
    () => null,
  );
}
