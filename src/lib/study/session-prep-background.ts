import { after } from 'next/server';

/** History is read only after the response. A cold memo never delays a feed. */
export function scheduleSessionPrepRefresh(userId: string, rotation: string): void {
  after(async () => {
    try {
      const { refreshOwnerSessionPrepBlend } = await import('./session-prep-blend.server');
      await refreshOwnerSessionPrepBlend(userId, rotation, new Date());
    } catch {
      // Personal prep is a preference; the ordinary feed remains available.
    }
  });
}
