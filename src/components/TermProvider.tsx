'use client';

import type { ReactNode } from 'react';

export function TermProvider({ children }: { domain: string; children: ReactNode }) {
  return children;
}

export function useTermContext() {
  return null;
}

export function useRequiredTermContext(): never {
  throw new Error('Glossary context is unavailable in this distribution');
}
