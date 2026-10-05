'use client';
import { useSyncExternalStore } from 'react';
import { clearFlagImageDeliveryNotice, hasFlagImageDeliveryNotice, subscribeFlagImageDeliveryNotice } from '@/lib/flags/image-delivery-notice';
export function FlagImageDeliveryNotice() {
  const visible = useSyncExternalStore(subscribeFlagImageDeliveryNotice, hasFlagImageDeliveryNotice, () => false);
  if (!visible) return null;
  return <div role="alert" className="fixed bottom-4 left-4 right-4 z-[110] mx-auto flex max-w-lg items-center gap-3 rounded-xl bg-[var(--md-error-container)] p-3 text-sm text-[var(--md-on-error-container)] shadow-lg">
    <p>Your flag note was sent, but its image was unavailable. Open that content’s flag again to attach the image.</p>
    <button className="min-h-11 shrink-0 px-2 underline" onClick={clearFlagImageDeliveryNotice}>Dismiss</button>
  </div>;
}
