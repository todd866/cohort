import type { Metadata } from 'next';
import {
  GAMSAT_LICENCE_NOTE,
  GAMSAT_PUBLIC_SOURCE_CTA,
  GAMSAT_PUBLIC_SOURCE_URL,
} from '@/lib/gamsat/public-source';

export const metadata: Metadata = {
  title: 'GAMSAT reasoning practice - cohort.md',
  description:
    'Free and open GAMSAT practice that names the reasoning move behind every question. '
    + 'Originally authored passages, CC BY 4.0.',
};

export default function GamsatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <footer className="mx-auto max-w-2xl px-4 pb-10 text-xs leading-relaxed text-[var(--md-on-surface-variant)] sm:px-6">
        <p>
          GAMSAT® is a registered trademark of the Australian Council for Educational Research
          (ACER). Cohort is independent and is not affiliated with, endorsed by, or derived from
          ACER. Every passage and question here is originally authored — no ACER material is
          reproduced, adapted, or reworded.
        </p>
        <p className="mt-3">
          {GAMSAT_LICENCE_NOTE}{' '}
          <a
            href={GAMSAT_PUBLIC_SOURCE_URL}
            className="font-semibold text-[var(--md-primary)] underline underline-offset-2 hover:opacity-90"
            rel="noopener noreferrer"
            target="_blank"
          >
            {GAMSAT_PUBLIC_SOURCE_CTA}
          </a>
        </p>
      </footer>
    </>
  );
}
