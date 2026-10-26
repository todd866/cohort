'use client';

import { useEffect } from 'react';
import { stripBrandSuffix } from '@/lib/brand/standalone-title';

/**
 * In the installed app, keep the brand out of the page title: the window
 * already prefixes the app's name. Next rewrites <title> on every client
 * navigation, so this watches the head rather than running once.
 */
export function StandaloneTitle({ brand }: { brand: string }) {
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: window-controls-overlay)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;
    const apply = () => {
      const next = stripBrandSuffix(document.title, brand);
      if (next !== document.title) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [brand]);
  return null;
}
