'use client';

import { useCallback, useState } from 'react';

const LOCAL_STORAGE_KEY = 'md3-active-modules';

interface ModuleNode {
  slug: string;
  children: ModuleNode[];
}

interface UseActiveModulesReturn {
  activeModules: string[];
  loading: boolean;
  toggle: (slug: string) => Promise<void>;
  setAll: (slugs: string[]) => Promise<void>;
  isActive: (slug: string) => boolean;
  isPartiallyActive: (slug: string, tree?: ModuleNode[]) => boolean;
}

function readLocalModules(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function writeLocalModules(slugs: string[]): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(slugs));
  } catch {
    // Storage-denied browsers still retain this choice in component state.
  }
}

export function useActiveModules(): UseActiveModulesReturn {
  const [activeModules, setActiveModules] = useState<string[]>(readLocalModules);
  const setAll = useCallback(async (slugs: string[]) => {
    const next = [...new Set(slugs)];
    setActiveModules(next);
    writeLocalModules(next);
  }, []);
  const toggle = useCallback(async (slug: string) => {
    setActiveModules((current) => {
      const next = current.includes(slug)
        ? current.filter((value) => value !== slug && !value.startsWith(`${slug}/`))
        : [...current, slug];
      writeLocalModules(next);
      return next;
    });
  }, []);
  const isActive = useCallback((slug: string) => {
    if (activeModules.includes(slug)) return true;
    const parts = slug.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (activeModules.includes(parts.slice(0, index).join('/'))) return true;
    }
    return false;
  }, [activeModules]);
  const isPartiallyActive = useCallback((slug: string, tree?: ModuleNode[]) => {
    const descendants = activeModules.filter((value) => value.startsWith(`${slug}/`));
    if (descendants.length === 0) return false;
    if (!tree) return !activeModules.includes(slug);
    const findNode = (nodes: ModuleNode[]): ModuleNode | null => {
      for (const node of nodes) {
        if (node.slug === slug) return node;
        const nested = findNode(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const node = findNode(tree);
    return node?.children.length
      ? !node.children.every((child) => activeModules.includes(child.slug))
      : !activeModules.includes(slug);
  }, [activeModules]);
  return { activeModules, loading: false, toggle, setAll, isActive, isPartiallyActive };
}

export function expandModuleFilter(activeModules: string[]): string[] {
  const expanded = new Set<string>();
  for (const slug of activeModules) {
    expanded.add(slug);
    const parts = slug.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index).join('/'));
    }
  }
  return [...expanded];
}
