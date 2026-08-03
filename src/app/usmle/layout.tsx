import type { Metadata } from 'next';
import { USMLE_PUBLIC_SOURCE_URL } from '@/lib/usmle/public-source';

export const metadata: Metadata = {
  title: 'USMLE study - MD3',
  description:
    'Public early open corpus: 25 original, citation-backed USMLE Step 1 MCQs with descriptive progress only.',
};

export default async function USMLELayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs leading-relaxed text-[var(--md-on-surface-variant)] sm:px-6">
        <p>
          USMLE® is a registered trademark of the Federation of State Medical Boards and the
          National Board of Medical Examiners. MD3/Cohort is independent and is not affiliated
          with or endorsed by either organization. This corpus uses original questions, not
          recalled exam items.
        </p>
        <p className="mt-3">
          <a
            href={USMLE_PUBLIC_SOURCE_URL}
            className="underline underline-offset-2 hover:text-[var(--md-primary)]"
            rel="noopener noreferrer"
            target="_blank"
          >
            Source
          </a>
        </p>
      </footer>
    </>
  );
}
