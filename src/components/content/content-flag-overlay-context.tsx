'use client';

import { createContext, useContext } from 'react';

export interface ContentFlagRequest {
  flagKey: string;
  targetType: 'card' | 'question' | 'component' | 'page';
  targetId: string;
  context: Record<string, unknown>;
}

interface ContentFlagOverlayContextValue {
  openFlag: (request: ContentFlagRequest) => void;
  isFlagged: (flagKey: string) => boolean;
}

const ContentFlagOverlayContext = createContext<ContentFlagOverlayContextValue | null>(null);

export const ContentFlagOverlayProvider = ContentFlagOverlayContext.Provider;

export function useContentFlagOverlay() {
  return useContext(ContentFlagOverlayContext);
}
