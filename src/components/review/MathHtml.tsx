'use client';

import { useEffect, useState } from 'react';

/**
 * Renders card text that contains math (real `$...$` LaTeX, or the medical
 * shortcuts O2/CO2/SpO2/… that render as subscripts). KaTeX (~75KB gz) is the
 * heaviest dependency on the review path, so it is loaded ON DEMAND via a
 * dynamic `import()` — keeping it OUT of First Load JS.
 *
 * Correctness (see the KaTeX-split adversarial review): a naïve
 * `next/dynamic({ ssr:false })` with no fallback renders BLANK while the chunk
 * loads and PERMANENTLY blank if it never loads (offline mid-session — the
 * `/_next/static` service-worker cache is cache-first, so a chunk not yet
 * fetched fails with no retry). Because callers pass the WHOLE text segment
 * (plain words included), that blanks an entire sentence, not just a glyph — on
 * the common O2/CO2/SpO2 cards, not a rare edge.
 *
 * So this component ALWAYS renders readable plain text first, upgrades to the
 * rendered math once KaTeX arrives, and STAYS on the readable text if the chunk
 * fails (a failed load resets the memo so the next card retries). Never blank.
 * Once loaded, the module-scoped renderer lets later instances render
 * synchronously — no per-card flash after the first math card of a session.
 *
 * Safe: KaTeX only produces mathematical HTML from our controlled card content,
 * never from user input.
 */
type Renderer = (text: string, useShortcuts?: boolean) => string;

let katexRenderer: Renderer | null = null;
let katexLoad: Promise<Renderer | null> | null = null;

function loadKatexRenderer(): Promise<Renderer | null> {
  if (katexRenderer) return Promise.resolve(katexRenderer);
  if (!katexLoad) {
    katexLoad = import('@/lib/math/render-math')
      .then((m) => (katexRenderer = m.renderCardMath))
      .catch(() => {
        // Chunk failed (e.g. offline before it was cached). Reset the memo so a
        // later card can retry; the readable fallback keeps this card usable.
        katexLoad = null;
        return null;
      });
  }
  return katexLoad;
}

export function MathHtml({
  text,
  as = 'span',
  className,
}: {
  text: string;
  as?: 'span' | 'strong';
  className?: string;
}) {
  const [renderer, setRenderer] = useState<Renderer | null>(katexRenderer);

  useEffect(() => {
    if (renderer) return;
    let alive = true;
    loadKatexRenderer().then((r) => {
      if (alive && r) setRenderer(() => r);
    });
    return () => {
      alive = false;
    };
  }, [renderer]);

  if (renderer) {
    const html = renderer(text, true);
    return as === 'strong' ? (
      <strong className={className} dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
    );
  }

  // Readable fallback — never blank, and persists if KaTeX never loads.
  return as === 'strong' ? (
    <strong className={className}>{text}</strong>
  ) : (
    <span className={className}>{text}</span>
  );
}
