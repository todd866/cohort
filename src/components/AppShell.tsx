'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isExperimentalPath } from '@/lib/experiments';
import { Navigation } from '@/components/Navigation';
import { ConnectionBanner } from '@/components/ConnectionBanner';

function SkipToMainContent() {
  return (
    <Link
      href="#main-content"
      className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-[var(--md-primary)] px-4 py-2 font-medium text-[var(--md-on-primary)] shadow-lg transition-transform focus:translate-y-0"
    >
      Skip to main content
    </Link>
  );
}

export function AppShell({
  children,
  isCohortHost = false,
}: {
  children: React.ReactNode;
  isCohortHost?: boolean;
}) {
  const pathname = usePathname();
  const isExperimental = isExperimentalPath(pathname);
  const isImmersiveLab = Boolean(
    pathname?.startsWith('/x/cockpit') || pathname?.startsWith('/videos')
  );
  const isReviewMode = Boolean(
    (pathname?.startsWith('/review') && pathname !== '/review') ||
    pathname?.startsWith('/study') ||
    pathname?.startsWith('/practice') ||
    pathname?.endsWith('/study')
  );

  if (isImmersiveLab) {
    return (
      <>
        <SkipToMainContent />
        <ConnectionBanner />
        <main id="main-content" tabIndex={-1} className="h-[100svh] overflow-hidden">
          {children}
        </main>
      </>
    );
  }

  // Review mode: full screen, no nav, content + sticky buttons managed by component
  if (isReviewMode) {
    return (
      <>
        <SkipToMainContent />
        <ConnectionBanner />
        <main id="main-content" tabIndex={-1} className="min-h-[100svh] flex flex-col">
          {children}
        </main>
      </>
    );
  }

  if (!isExperimental) {
    return (
      <>
        <SkipToMainContent />
        <ConnectionBanner />
        <Navigation isCohortHost={isCohortHost} />
        <main id="main-content" tabIndex={-1} className="md:pl-20 pb-24 md:pb-0 [--md-review-footer-bottom:5rem] md:[--md-review-footer-bottom:0px]">
          {children}
        </main>
        <footer className="md:pl-20 pb-24 md:pb-4 text-center text-xs text-[var(--md-on-surface-variant)]">
          <Link className="hover:text-[var(--md-primary)] hover:underline" href="/privacy">
            Privacy
          </Link>
          <span aria-hidden="true" className="mx-2">&middot;</span>
          <Link className="hover:text-[var(--md-primary)] hover:underline" href="/terms">
            Terms
          </Link>
        </footer>
      </>
    );
  }

  return (
    <>
      <SkipToMainContent />
      <ConnectionBanner />
      <div className="sticky top-0 z-50 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface)]/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center justify-between">
          <div className="text-xs font-semibold tracking-wide text-[var(--md-on-surface-variant)]">
            Experimental
          </div>
          <Link
            href="/"
            className="text-sm text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]"
          >
            Back to MD3
          </Link>
        </div>
      </div>
      <main id="main-content" tabIndex={-1} className="pb-10">
        {children}
      </main>
    </>
  );
}
