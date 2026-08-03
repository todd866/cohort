export const OFFLINE_SHELL_STATE_EVENT = 'md3:offline-shell-state';
export const OFFLINE_NAVIGATE_EVENT = 'md3:offline-navigate';
export const RSC_NAVIGATION_FAILED_MESSAGE = 'md3-rsc-navigation-failed';
export const PENDING_OFFLINE_NAV_KEY = 'md3:pending-offline-navigation';

export type OfflinePrimaryPath = '/' | '/exams' | '/content' | '/profile';

export type OfflineView =
  | { kind: 'review' }
  | { kind: 'clinical'; slug: string | null }
  | { kind: 'clinical-lesson'; slug: string }
  | { kind: 'content' }
  | { kind: 'profile' }
  | { kind: 'stats' }
  | { kind: 'brief' }
  | { kind: 'unavailable'; requestedPath: string };

export interface OfflineShellStateDetail {
  active: boolean;
  path: string;
  hasClinical: boolean;
}

export interface OfflineNavigateDetail {
  path: string;
}

function normalisePath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || '/';
  if (withoutQuery === '/') return '/';
  return withoutQuery.replace(/\/+$/, '') || '/';
}

export function offlineViewForPath(pathname: string): OfflineView {
  const path = normalisePath(pathname);
  if (path === '/' || path === '/usmle/step1') return { kind: 'review' };
  if (path === '/content') return { kind: 'content' };
  if (path === '/exams') return { kind: 'clinical', slug: null };
  if (path.startsWith('/exams/')) {
    const segments = path.slice('/exams/'.length).split('/');
    if (segments.length === 1 && segments[0]) {
      return { kind: 'clinical', slug: segments[0] };
    }
    if (segments.length === 2 && segments[0] && segments[1] === 'learn') {
      return { kind: 'clinical-lesson', slug: segments[0] };
    }
  }
  if (path === '/profile' || path === '/offline') return { kind: 'profile' };
  if (path === '/profile/stats') return { kind: 'stats' };
  if (path === '/profile/brief' || path === '/brief') return { kind: 'brief' };
  return { kind: 'unavailable', requestedPath: path };
}

export function isOfflineLocalPath(pathname: string): boolean {
  return offlineViewForPath(pathname).kind !== 'unavailable';
}

export function activeOfflineTab(pathname: string): OfflinePrimaryPath {
  const view = offlineViewForPath(pathname);
  if (view.kind === 'clinical' || view.kind === 'clinical-lesson') return '/exams';
  if (view.kind === 'content') return '/content';
  if (view.kind === 'profile' || view.kind === 'stats' || view.kind === 'brief') {
    return '/profile';
  }
  if (view.kind === 'unavailable') {
    const path = normalisePath(pathname);
    if (path.startsWith('/exams')) return '/exams';
    if (path.startsWith('/profile') || path === '/brief') return '/profile';
    if (
      path.startsWith('/content') ||
      /^\/(critical-care|paam|cah|pwh)(?:\/|$)/.test(path)
    ) {
      return '/content';
    }
  }
  return '/';
}
