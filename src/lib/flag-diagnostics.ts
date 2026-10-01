/**
 * Render-environment harvest captured at flag time.
 *
 * Why: a flag like "context cut off" was undiagnosable after the fact — we knew
 * the card and the note, but not the viewport, route, or whether anything was
 * actually clipped on the user's screen. The render path looked clean in every
 * place we checked, yet the flag stood. Capturing the render environment at the
 * moment of flagging turns "I dunno, I don't have evidence" into a query.
 *
 * `computeFlagDiagnostics` is the pure core (testable); `harvestFlagDiagnostics`
 * measures the live DOM and delegates to it.
 */

export interface FlagDiagnosticsEnv {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  pathname: string;
  userAgent: string;
  /** document.scrollingElement.scrollHeight — total content height. */
  scrollHeight: number;
  /**
   * Top Y (viewport coords) of the highest-reaching fixed element occupying the
   * lower part of the viewport (grading footer, bottom nav…), or null if none.
   * This is the line below which content is visually occluded by fixed UI.
   */
  lowestFixedBottomTop: number | null;
}

// A `type` (not `interface`) so it is assignable to the FlagPayload `context`
// field's `Record<string, unknown>` — interfaces lack an implicit index signature.
export type FlagDiagnostics = {
  viewport: { w: number; h: number; dpr: number };
  route: string;
  ua: string;
  /** Pixels of content extending past the viewport (0 = everything fits). */
  overflowPx: number;
  /** Pixels of the viewport bottom covered by fixed UI (0 = nothing fixed below). */
  bottomCoverPx: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeFlagDiagnostics(env: FlagDiagnosticsEnv): FlagDiagnostics {
  const overflowPx = Math.max(0, Math.round(env.scrollHeight - env.innerHeight));
  const bottomCoverPx =
    env.lowestFixedBottomTop == null
      ? 0
      : Math.max(0, Math.round(env.innerHeight - env.lowestFixedBottomTop));
  return {
    viewport: {
      w: Math.round(env.innerWidth),
      h: Math.round(env.innerHeight),
      dpr: round2(env.devicePixelRatio),
    },
    route: env.pathname,
    ua: env.userAgent.slice(0, 300),
    overflowPx,
    bottomCoverPx,
  };
}

/**
 * Measure the live document and return the render diagnostics, or undefined when
 * not in a browser (SSR) or if measurement throws. Cheap enough for a rare,
 * user-initiated action; never let it block or fail a flag submission.
 */
export function harvestFlagDiagnostics(): FlagDiagnostics | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
  try {
    const ih = window.innerHeight;
    const scroller = document.scrollingElement || document.documentElement;

    // Highest-reaching fixed bar in the lower half of the viewport. The grading
    // footer and the bottom nav are both fixed and stacked; we want the topmost
    // edge of that occluding block (the smallest `top`).
    let lowestFixedBottomTop: number | null = null;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = window.getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.height < 1 || r.width < 1) continue;
      // Element whose vertical centre sits in the lower half → a bottom overlay.
      if ((r.top + r.bottom) / 2 > ih * 0.5) {
        lowestFixedBottomTop =
          lowestFixedBottomTop == null ? r.top : Math.min(lowestFixedBottomTop, r.top);
      }
    }

    return computeFlagDiagnostics({
      innerWidth: window.innerWidth,
      innerHeight: ih,
      devicePixelRatio: window.devicePixelRatio || 1,
      pathname: window.location.pathname,
      userAgent: navigator.userAgent,
      scrollHeight: scroller.scrollHeight,
      lowestFixedBottomTop,
    });
  } catch {
    return undefined;
  }
}
