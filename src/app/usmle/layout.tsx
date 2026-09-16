import type { Metadata } from 'next';
import {
  USMLE_PUBLIC_SOURCE_BLURB,
  USMLE_PUBLIC_SOURCE_CTA,
  USMLE_PUBLIC_SOURCE_URL,
} from '@/lib/usmle/public-source';

export const metadata: Metadata = {
  title: 'USMLE study - cohort.md',
  description:
    'Public FOSS Step 1 MCQs with citation trails. Study on cohort.md, or fork the open corpus on GitHub.',
};

export default async function USMLELayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <footer className="mx-auto max-w-xl px-4 pb-10 text-xs leading-relaxed text-[var(--md-on-surface-variant)] sm:px-6">
        <p>
          USMLE® is a registered trademark of the Federation of State Medical Boards and the
          National Board of Medical Examiners. MD3/Cohort is independent and is not affiliated
          with or endorsed by either organization. This corpus uses original questions, not
          recalled exam items.
        </p>
        <p className="mt-3">
          {USMLE_PUBLIC_SOURCE_BLURB}{' '}
          <a
            href={USMLE_PUBLIC_SOURCE_URL}
            className="font-semibold text-[var(--md-primary)] underline underline-offset-2 hover:opacity-90"
            rel="noopener noreferrer"
            target="_blank"
          >
            {USMLE_PUBLIC_SOURCE_CTA}
          </a>
        </p>
      </footer>
    </>
  );
}
