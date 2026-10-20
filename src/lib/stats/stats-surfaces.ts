/**
 * Which private-instance controls the statistics page may offer on this
 * host. Cohort is served by the same deployment, but the Exam gaps page and
 * the layout API answer 404 there, so on Cohort the link is hidden and the
 * layout menu applies changes for the visit without saving them.
 */
import { isCohortHostname } from '@/lib/institution';
import { EXAM_GAPS_HREF, STATS_LAYOUT_ENDPOINT } from './private-surfaces';

export interface StatsSurfaces {
  examGapsHref: string | null;
  layoutEndpoint: string | null;
}

/** `host` as the Host header gives it (a port is ignored). */
export function statsSurfacesForHost(host: string): StatsSurfaces {
  const hostname = host.split(':')[0] ?? '';
  if (isCohortHostname(hostname)) return { examGapsHref: null, layoutEndpoint: null };
  return { examGapsHref: EXAM_GAPS_HREF, layoutEndpoint: STATS_LAYOUT_ENDPOINT };
}
