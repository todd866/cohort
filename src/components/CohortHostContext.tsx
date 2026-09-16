'use client';

import { createContext, useContext, type ReactNode } from 'react';

const CohortHostContext = createContext(false);

export function CohortHostProvider({
  isCohortHost,
  children,
}: {
  isCohortHost: boolean;
  children: ReactNode;
}) {
  return (
    <CohortHostContext.Provider value={isCohortHost}>
      {children}
    </CohortHostContext.Provider>
  );
}

/** True on cohort.md (and www), false on md3.info / localhost. */
export function useCohortHost(): boolean {
  return useContext(CohortHostContext);
}
