'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize from localStorage synchronously to avoid flash
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system';
    try {
      return (localStorage.getItem('theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      if (isDark) {
        root.classList.add('dark');
        setResolvedTheme('dark');
      } else {
        root.classList.remove('dark');
        setResolvedTheme('light');
      }
    };

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent | MediaQueryList) => {
        if (typeof e === 'object' && e && 'matches' in e && typeof e.matches === 'boolean') {
          applyTheme(e.matches);
          return;
        }
        applyTheme(mediaQuery.matches);
      };

      const hasModernListener = typeof mediaQuery.addEventListener === 'function';
      const hasLegacyListener = typeof (mediaQuery as MediaQueryList & { addListener?: unknown }).addListener === 'function';

      if (hasModernListener) {
        mediaQuery.addEventListener('change', handler);
        return () => mediaQuery.removeEventListener('change', handler);
      }

      if (hasLegacyListener) {
        (mediaQuery as MediaQueryList & { addListener: (listener: typeof handler) => void }).addListener(handler);
        return () => {
          (mediaQuery as MediaQueryList & { removeListener: (listener: typeof handler) => void }).removeListener(handler);
        };
      }

      return;
    } else {
      applyTheme(theme === 'dark');
    }
  }, [theme]);

  const handleSetTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    try {
      localStorage.setItem('theme', newTheme);
    } catch {
      // Ignore storage errors (e.g., private mode or restricted storage).
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
