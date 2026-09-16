'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { TECH_DECK, type DeckSlide } from '@/lib/tech-deck';

/**
 * Keyboard-driven deck renderer.
 *
 * Deliberately not a carousel library: the deck is data, one slide renders at a
 * time, and every slide is also reachable as plain scrolled content with
 * JavaScript disabled (see the noscript list in the page). Arrow keys and the
 * on-screen controls move between slides; nothing animates in a way that would
 * cost layout shift.
 */
export function TechDeck() {
  const slides = TECH_DECK.slides;
  const [index, setIndex] = useState(0);

  const go = useCallback((delta: number) => {
    setIndex((i) => Math.min(slides.length - 1, Math.max(0, i + delta)));
  }, [slides.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      if (e.key === 'Home') setIndex(0);
      if (e.key === 'End') setIndex(slides.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, slides.length]);

  const slide = slides[index];

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-3xl flex-col px-5 py-8 sm:px-8">
      <div className="flex items-baseline justify-between text-xs text-[var(--md-on-surface-variant)]">
        <span>{TECH_DECK.meta.title}</span>
        <span aria-live="polite">{index + 1} / {slides.length}</span>
      </div>

      <section className="flex flex-1 flex-col justify-center py-10">
        <Slide slide={slide} />
      </section>

      <nav className="flex items-center justify-between gap-4 border-t border-[var(--md-outline-variant)] pt-4">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          className="min-h-11 rounded-lg px-4 text-sm font-medium text-[var(--md-primary)] disabled:opacity-40"
        >
          ← Back
        </button>
        <div className="flex gap-1.5" aria-hidden="true">
          {slides.map((s, i) => (
            <span
              key={s.id}
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: i === index
                  ? 'var(--md-primary)'
                  : 'var(--md-outline-variant)',
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index === slides.length - 1}
          className="min-h-11 rounded-lg px-4 text-sm font-medium text-[var(--md-primary)] disabled:opacity-40"
        >
          Next →
        </button>
      </nav>
      <p className="pt-3 text-center text-xs text-[var(--md-on-surface-variant)]">
        Arrow keys to move
      </p>
    </div>
  );
}

export function Slide({ slide }: { slide: DeckSlide }) {
  return (
    <article>
      {slide.eyebrow ? (
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--md-primary)]">
          {slide.eyebrow}
        </p>
      ) : null}

      {slide.title ? (
        <h2 className="mt-3 whitespace-pre-line text-3xl font-bold tracking-tight text-[var(--md-on-surface)] sm:text-4xl">
          {slide.title}
        </h2>
      ) : null}

      {slide.subtitle ? (
        <p className="mt-4 text-lg text-[var(--md-on-surface-variant)]">{slide.subtitle}</p>
      ) : null}

      {slide.chips?.length ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {slide.chips.map((chip) => (
            <li
              key={chip.text}
              className="rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-3 py-1 text-sm text-[var(--md-on-surface-variant)]"
            >
              {chip.text}
            </li>
          ))}
        </ul>
      ) : null}

      {slide.body?.length ? (
        <div className="mt-6 space-y-4">
          {slide.body.map((para) => (
            <p key={para.slice(0, 32)} className="text-[var(--md-on-surface)]">{para}</p>
          ))}
        </div>
      ) : null}

      {slide.steps?.length ? (
        <ol className="mt-8 space-y-5">
          {slide.steps.map((step, i) => (
            <li key={step.head} className="flex gap-4">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-surface-container-high)] text-sm font-semibold text-[var(--md-primary)]">
                {i + 1}
              </span>
              <div>
                <p className="font-semibold text-[var(--md-on-surface)]">{step.head}</p>
                <p className="mt-1 text-[var(--md-on-surface-variant)]">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {slide.equation ? (
        <div className="mt-8">
          <p className="overflow-x-auto rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-5 py-4 text-center font-mono text-base text-[var(--md-on-surface)]">
            {slide.equation}
          </p>
          {slide.equationNote ? (
            <p className="mt-4 text-[var(--md-on-surface-variant)]">{slide.equationNote}</p>
          ) : null}
        </div>
      ) : null}

      {slide.metrics?.length ? (
        <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {slide.metrics.map((m) => (
            <div
              key={m.label}
              className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-4"
            >
              <dt className="text-xs uppercase tracking-wide text-[var(--md-on-surface-variant)]">
                {m.label}
              </dt>
              <dd className="mt-1 text-2xl font-bold tabular-nums text-[var(--md-on-surface)]">
                {m.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {slide.takeaways?.length ? (
        <ul className="mt-8 space-y-4">
          {slide.takeaways.map((t) => (
            <li key={t.slice(0, 32)} className="flex gap-3 text-[var(--md-on-surface)]">
              <span aria-hidden="true" className="text-[var(--md-primary)]">—</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {slide.href ? (
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link
            href={slide.href}
            className="inline-block min-h-11 rounded-xl bg-[var(--md-primary)] px-6 py-3 font-medium text-[var(--md-on-primary)]"
          >
            {slide.hrefLabel ?? slide.href}
          </Link>
          {slide.secondaryHref ? (
            <Link
              href={slide.secondaryHref}
              className="min-h-11 py-3 text-sm font-medium text-[var(--md-primary)] underline"
            >
              {slide.secondaryLabel ?? slide.secondaryHref}
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
