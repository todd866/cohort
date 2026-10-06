import { anatomyFocusSvg } from '@/lib/figures/anatomy-focus-figure.server';
import { isAnatomyFocusFigureId } from '@/lib/cohort/anatomy-figure-catalogue';
import { isCohortHostname } from '@/lib/institution';
import { readAnatomySourceFigure } from '@/lib/figures/anatomy-source-figure.server';
import { blockedFigureResponse } from '@/lib/figures/open-figure-delivery';

function respond(request: Request, withBody: boolean): Response {
  if (!isCohortHostname(request.headers.get('host') ?? new URL(request.url).hostname)) return blockedFigureResponse();
  const params = new URL(request.url).searchParams;
  // These labelled teaching figures are intentionally unavailable as prompts.
  if ([...params.keys()].some(key => !['figure', 'target', 'phase'].includes(key))
    || ['figure', 'target', 'phase'].some(key => params.getAll(key).length !== 1)) return blockedFigureResponse();
  if (isAnatomyFocusFigureId(params.get('figure'))) {
    const svg = anatomyFocusSvg(params.get('figure'), params.get('target'), params.get('phase'));
    return svg ? new Response(withBody ? svg : null, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Host' } }) : blockedFigureResponse();
  }
  if (params.get('phase') !== 'answer' || params.get('target') !== 'overview') return blockedFigureResponse();
  const result = readAnatomySourceFigure(params.get('figure'));
  if (!result) return blockedFigureResponse();
  return new Response(withBody ? new Uint8Array(result.bytes) : null, { headers: {
    'Content-Type': result.figure.mime,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Host',
  } });
}
export function GET(request: Request): Response { return respond(request, true); }
export function HEAD(request: Request): Response { return respond(request, false); }
