'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type ItemAbbreviations = Readonly<Record<string, string>>;
const ItemDecodeMap = createContext<ItemAbbreviations | null | undefined>(undefined);

/** An explicit map (including {}) is authoritative for this content item. */
export function GlossaryScope({ abbreviations, children }: {
  abbreviations?: ItemAbbreviations | null;
  children: ReactNode;
}) {
  return <ItemDecodeMap.Provider value={abbreviations}>{children}</ItemDecodeMap.Provider>;
}

export function useItemAbbreviations() {
  return useContext(ItemDecodeMap);
}
