const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonempty = (value: unknown): boolean => {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.some(nonempty);
  if (record(value)) return Object.values(value).some(nonempty);
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
};
const named = (value: unknown): boolean => text(value)
  || (record(value) && ['id', 'label', 'name'].some(key => text(value[key])));

function httpsUrl(value: unknown): boolean {
  if (!text(value) || /[\s\\]/.test(value) || !/^https:\/\/[^/?#]/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname
      && !url.username && !url.password && !value.slice(8).split(/[/?#]/, 1)[0].includes('@');
  } catch { return false; }
}

/** Structural admission only; source accuracy and pixel matching still require review.
 * Keep the same minimum contract in scripts/export/build_medical_figures.py.
 */
export function validateOriginalFigureScaffold(value: unknown, figureId: string,
  expected?: { kind: 'conceptual' | 'spatial-anatomy'; sha256: string },
): void {
  function requireValue(condition: unknown, detail: string): asserts condition {
    if (!condition) throw new Error(`Original figures: ${figureId}: invalid scaffold: ${detail}`);
  }
  requireValue(record(value), 'JSON object required');
  // Both authoring schemas are held. Bind every supplied identity, so adding a
  // valid alias cannot conceal a different figure in the other identity field.
  requireValue(('figureId' in value || 'id' in value)
    && (!('figureId' in value) || value.figureId === figureId)
    && (!('id' in value) || value.id === figureId), 'exact figure identity required');
  requireValue(value.kind === 'conceptual' || value.kind === 'spatial-anatomy', 'supported kind required');
  requireValue(!expected || value.kind === expected.kind, 'kind must match manifest');
  requireValue(Array.isArray(value.sourceFacts) && value.sourceFacts.length > 0, 'sourceFacts required');
  for (const fact of value.sourceFacts) {
    requireValue(record(fact) && text(fact.fact), 'named clinical source fact required');
    requireValue('sourceUrls' in fact || 'sources' in fact, 'fact source URLs required');
    for (const key of ['sourceUrls', 'sources']) {
      if (!(key in fact)) continue;
      const sources = fact[key];
      requireValue(Array.isArray(sources) && sources.length > 0 && sources.every(source =>
        httpsUrl(key === 'sources' && record(source) ? source.url : source)), 'valid HTTPS fact source URLs required');
    }
  }
  requireValue(Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.every(named), 'named nodes required');
  let hasFlow = false;
  if ('edges' in value) {
    // Comparisons may explicitly declare no arrows; do not invent causal edges.
    requireValue(Array.isArray(value.edges) && value.edges.every(edge =>
      Array.isArray(edge) ? edge.length >= 2 && edge.every(text)
        : record(edge) && text(edge.from) && text(edge.to)
          && (!('meaning' in edge) || text(edge.meaning))), 'edge endpoints required');
    hasFlow = true;
  }
  for (const key of ['steps', 'sequence']) {
    if (!(key in value)) continue;
    const steps = value[key];
    // A comparison can hold parallel ordered sequences, each one level deep.
    requireValue(Array.isArray(steps) && steps.length > 0 && steps.every(step =>
      Array.isArray(step) ? step.length > 0 && step.every(named) : named(step)), 'named ordered steps required');
    hasFlow = true;
  }
  requireValue(hasFlow, 'explicit edges or ordered steps required');
  requireValue(Array.isArray(value.forbiddenAnatomy) && value.forbiddenAnatomy.length > 0
    && value.forbiddenAnatomy.every(text), 'forbiddenAnatomy required');
  requireValue(record(value.validation) && nonempty(value.validation), 'nonempty validation record required');
  if (value.kind === 'spatial-anatomy') {
    const review = value.validation;
    requireValue(expected && /^[a-f0-9]{64}$/.test(expected.sha256), 'anatomy requires manifest hash binding');
    requireValue(text(review.reviewer) && text(review.notes), 'anatomy reviewer and notes required');
    const reviewedAt = review.reviewedAt;
    const parsed = typeof reviewedAt === 'string' && !reviewedAt.startsWith('0000') && /^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)
      ? new Date(`${reviewedAt}T00:00:00Z`) : new Date(NaN);
    requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === reviewedAt,
      'valid anatomy reviewedAt required');
    for (const key of ['baseSha256', 'annotationSha256', 'finalSha256']) {
      requireValue(typeof review[key] === 'string' && /^[a-f0-9]{64}$/.test(review[key]), `valid anatomy ${key} required`);
    }
    requireValue(review.finalSha256 === expected.sha256, 'anatomy finalSha256 must match figure sha256');
    requireValue(record(review.checks) && ['sourceComparison', 'blindEndpoints', 'leaders', 'fullSize', 'mobile375']
      .every(key => (review.checks as Record<string, unknown>)[key] === true), 'all anatomy review checks must be true');
  }
}
