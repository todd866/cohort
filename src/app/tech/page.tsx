import type { Metadata } from 'next';
import Link from 'next/link';
import { TechDeck, Slide } from '@/components/tech/TechDeck';
import { TECH_DECK, TECH_DECK_REPO } from '@/lib/tech-deck';

export const metadata: Metadata = {
  title: 'How this works — cohort.md',
  description:
    'Spaced repetition over concepts embedded in a 3,072-dimensional vector space: '
    + 'the model, the gap direction the scheduler walks, and where the machinery is.',
};

/**
 * The technical explainer.
 *
 * Public and unauthenticated by design — it is the page you send someone who
 * asks what this actually does. It reads from the same deck data the renderer
 * uses, so the interactive deck and the no-JavaScript fallback below cannot
 * disagree about what the talk says.
 */
export default function TechPage() {
  return (
    <>
      <TechDeck />

      {/* Every slide, as plain scrolled content. Crawlable, linkable, and the
          page still says everything with JavaScript disabled. */}
      <noscript>
        <main className="mx-auto max-w-2xl space-y-16 px-5 py-12 sm:px-8">
          <header>
            <h1 className="text-3xl font-bold text-[var(--md-on-surface)]">
              {TECH_DECK.meta.title}
            </h1>
            <p className="mt-2 text-[var(--md-on-surface-variant)]">
              {TECH_DECK.meta.subtitle}
            </p>
          </header>
          {TECH_DECK.slides.map((slide) => (
            <Slide key={slide.id} slide={slide} />
          ))}
          <p>
            <Link href={TECH_DECK_REPO}>{TECH_DECK_REPO}</Link>
          </p>
        </main>
      </noscript>
    </>
  );
}
