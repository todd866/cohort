'use client';

import Link from 'next/link';
import { useDeepDiveTracking } from '@/hooks/useTracking';
import { InlineMarkdown } from '@/lib/inline-markdown';

interface DeepDiveProps {
  href: string;
  title: string;
  description: string;
  duration?: string;
  hasVideo?: boolean;
  id?: string;
}

export function DeepDive({ href, title, description, duration, hasVideo, id }: DeepDiveProps) {
  const { onOpen } = useDeepDiveTracking(id || title);

  return (
    <Link href={href} className="block my-4 no-underline" onClick={onOpen}>
      <div className="rounded-xl border border-[var(--md-primary)] bg-[var(--md-primary-container)] p-4 hover:shadow-[var(--md-shadow-2)] transition-all duration-200 hover:scale-[1.01]">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-[var(--md-primary)] flex items-center justify-center">
            {hasVideo ? (
              <svg className="w-5 h-5 text-[var(--md-on-primary)]" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-[var(--md-on-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-[var(--md-on-primary-container)]">{title}</span>
              <svg className="w-4 h-4 text-[var(--md-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </div>
            <p className="text-sm text-[var(--md-on-primary-container)] opacity-80 line-clamp-2">
              <InlineMarkdown text={description} />
            </p>
            {duration && (
              <div className="mt-2 flex items-center gap-1 text-xs text-[var(--md-primary)] font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {duration}
              </div>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
