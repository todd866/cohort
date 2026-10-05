import { isCohortHostname } from '@/lib/institution';
import { blockedFigureResponse, openFigureResponse, readOpenFigure } from '@/lib/figures/open-figure-delivery';

import { anatomyPromptSvg, isAnatomyPromptTarget } from '@/lib/figures/anatomy-prompt';

/** One reviewed public illustration. No caller-controlled path or filesystem input. */
function response(request: Request, withBody: boolean): Response {
  if (!isCohortHostname(request.headers.get('host') ?? new URL(request.url).hostname)) return blockedFigureResponse();
  const query = new URL(request.url).searchParams;
  const phase = query.get('phase');
  const target = query.get('target');
  if (phase && phase !== 'prompt' && phase !== 'answer') return blockedFigureResponse();
  if (target && !isAnatomyPromptTarget(target)) return blockedFigureResponse();
  if (phase === 'prompt') {
    if (!isAnatomyPromptTarget(target)) return blockedFigureResponse();
    const approved = readOpenFigure(['anatomy', 'abducens-local.svg'], { hostname: 'cohort.md' });
    const svg = approved && anatomyPromptSvg(approved, target);
    if (!svg) return blockedFigureResponse();
    return new Response(withBody ? svg : null, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'Host' } });
  }
  return openFigureResponse(['anatomy', 'abducens-local.svg'], withBody, { hostname: 'cohort.md' });
}
export function GET(request: Request): Response { return response(request, true); }
export function HEAD(request: Request): Response { return response(request, false); }
