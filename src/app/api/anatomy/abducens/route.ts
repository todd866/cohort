import { isCohortHostname } from '@/lib/institution';
import { blockedFigureResponse, openFigureResponse } from '@/lib/figures/open-figure-delivery';

/** One reviewed public illustration. No caller-controlled path or filesystem input. */
function response(request: Request, withBody: boolean): Response {
  if (!isCohortHostname(request.headers.get('host') ?? new URL(request.url).hostname)) return blockedFigureResponse();
  return openFigureResponse(['anatomy', 'abducens-local.svg'], withBody, { hostname: 'cohort.md' });
}
export function GET(request: Request): Response { return response(request, true); }
export function HEAD(request: Request): Response { return response(request, false); }
