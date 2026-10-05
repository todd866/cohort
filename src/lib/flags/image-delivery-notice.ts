import { captureOfflineOwner, isOfflineOwnerCurrent, subscribeOfflineOwner, type OwnerLease } from '@/lib/offline/owner';
const KEY = 'md3:flag-image-delivery-notice';
const EVENT = 'flag-image-delivery-notice';
let memory: OwnerLease | null = null;
export function recordFlagImageDeliveryNotice(owner = captureOfflineOwner()) {
  if (!isOfflineOwnerCurrent(owner)) return;
  memory = owner;
  try { sessionStorage.setItem(KEY, JSON.stringify(owner)); } catch {}
  window.dispatchEvent(new Event(EVENT));
}
export function hasFlagImageDeliveryNotice() {
  try { const raw = sessionStorage.getItem(KEY); if (raw) memory = JSON.parse(raw); } catch {}
  return !!memory && isOfflineOwnerCurrent(memory);
}
export function clearFlagImageDeliveryNotice() {
  memory = null; try { sessionStorage.removeItem(KEY); } catch {}
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeFlagImageDeliveryNotice(fn: () => void) {
  const unsubscribe = subscribeOfflineOwner(() => { if (!hasFlagImageDeliveryNotice()) clearFlagImageDeliveryNotice(); fn(); });
  window.addEventListener(EVENT, fn);
  return () => { unsubscribe(); window.removeEventListener(EVENT, fn); };
}
