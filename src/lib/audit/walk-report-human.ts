import type { WalkAuditReport, SessionMetrics, Pathology, Session } from './walk-types';
import { formatConceptThreadTelemetryLine } from './concept-thread-telemetry';

const BAR = '═══════════════════════════════════════';
const RULE = '──────────────────────────────────────────────';

function fmtPct(x: number | null): string {
  return x == null ? '—' : `${(x * 100).toFixed(0)}%`;
}

function fmtNum(x: number | null, digits = 2): string {
  return x == null ? '—' : x.toFixed(digits);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtTime(d: Date): string {
  return d.toISOString().slice(11, 16);
}

function coherenceFlag(m: SessionMetrics): string {
  if (m.avgSimilarityConsecutive == null) return '';
  if (m.avgSimilarityConsecutive < 0.4) return '⚠';
  if (m.avgSimilarityConsecutive > 0.7) return '⚠';
  return '✓';
}

function recallFlag(m: SessionMetrics): string {
  if (m.avgPredictedRecall == null) return '';
  if (m.avgPredictedRecall > 0.85 || m.avgPredictedRecall < 0.3) return '⚠';
  return '✓';
}

function scaffoldFlag(m: SessionMetrics): string {
  if (m.scaffoldingRateAfterMiss == null) return '';
  return m.scaffoldingRateAfterMiss < 0.2 ? '⚠ LOW' : '✓';
}

function renderSessionBlock(
  i: number,
  total: number,
  session: Session,
  metrics: SessionMetrics,
  pathologies: Pathology[],
): string {
  const lines: string[] = [];
  const feedTag = session.feedMode === 'new-only' ? '  │  new-only' : '';
  const header = `Session ${i + 1} of ${total}  │  ${fmtTime(session.startedAt)}–${fmtTime(session.endedAt)}  │  ${metrics.itemCount} items, ${fmtPct(metrics.accuracy)} acc${feedTag}`;
  lines.push(header);
  lines.push(RULE);
  lines.push(`  Coherence:        ${fmtNum(metrics.avgSimilarityConsecutive)}   ${coherenceFlag(metrics)}  (sweet spot 0.4–0.7)`);
  lines.push(`  Cluster spread:   ${metrics.clustersVisited}/${metrics.itemCount} clusters, max run ${metrics.maxConsecutiveSameCluster}`);
  lines.push(`  Pre-serve proxy:  ${fmtNum(metrics.avgPredictedRecall)}   ${recallFlag(metrics)}  (not observed correctness)`);
  lines.push(`  Post-miss scaff:  ${fmtPct(metrics.scaffoldingRateAfterMiss)}   ${scaffoldFlag(metrics)}`);
  lines.push(`  Challenge fit:    ${fmtPct(metrics.challengeMatchRate)} match  │  ${fmtPct(metrics.challengePolicyCoverage)} coverage  │  gap ${fmtNum(metrics.avgChallengeDistance)}`);
  lines.push(`  Challenge action: ${fmtPct(metrics.challengeAppliedRate)} applied (MCQ observations remain shadow)`);
  lines.push(`  Novelty guard:    ${fmtPct(metrics.recentNearDuplicateRate)} recent-neighbour served  │  ${fmtPct(metrics.noveltyPolicyCoverage)} card serves evaluated`);
  lines.push(`  Content rating:   ${metrics.ratingCount} active  │  ${fmtPct(metrics.ratingResponseRate)} response  │  ${fmtPct(metrics.positiveRatingRate)} good`);
  if (pathologies.length > 0) {
    lines.push('');
    for (const p of pathologies) {
      lines.push(`  ⚠ ${p.kind}: ${p.detail}`);
    }
  }
  return lines.join('\n');
}

export function formatHumanReport(report: WalkAuditReport): string {
  const lines: string[] = [];
  lines.push(BAR);
  lines.push(`      WALK AUDIT — ${report.userLabel}, ${fmtDate(report.window.to)}`);
  lines.push(BAR);
  lines.push('');

  if (report.sessions.length === 0) {
    lines.push('No sessions in window.');
    return lines.join('\n');
  }

  report.sessions.forEach((entry, i) => {
    lines.push(
      renderSessionBlock(i, report.sessions.length, entry.session, entry.metrics, entry.pathologies),
    );
    lines.push('');
  });

  lines.push(BAR);
  lines.push(`              ROLLUP (${report.window.days} day${report.window.days === 1 ? '' : 's'})`);
  lines.push(BAR);
  lines.push(`  Sessions: ${report.rollup.sessionCount}   Items: ${report.rollup.itemCount}   Avg coherence: ${fmtNum(report.rollup.avgCoherence)}`);
  const fc = report.rollup.feedModeCounts;
  if (fc.mixed + fc['new-only'] > 0) {
    lines.push(`  Feed mode:   mixed × ${fc.mixed},  new-only × ${fc['new-only']}`);
  }
  if (report.rollup.conceptThreadEligibleCount > 0) {
    lines.push(`  ${formatConceptThreadTelemetryLine({
      eligibleCount: report.rollup.conceptThreadEligibleCount,
      policyObservedCount: report.rollup.conceptThreadPolicyObservedCount,
      policyCoverage: report.rollup.conceptThreadPolicyCoverage,
      appliedCount: report.rollup.conceptThreadAppliedCount,
      appliedRate: report.rollup.conceptThreadAppliedRate,
      completeAppliedCount: report.rollup.conceptThreadCompleteAppliedCount,
      medianAgeMs: report.rollup.conceptThreadMedianAgeMs,
      ageSampleCount: report.rollup.conceptThreadAgeSampleCount,
      medianInterveningExposures:
        report.rollup.conceptThreadMedianInterveningExposures,
      interveningExposureSampleCount:
        report.rollup.conceptThreadInterveningExposureSampleCount,
      answeredAppliedCount: report.rollup.conceptThreadAnsweredAppliedCount,
      appliedCorrectCount: report.rollup.conceptThreadAppliedCorrectCount,
      appliedCorrectnessRate: report.rollup.conceptThreadAppliedCorrectnessRate,
    })}`);
  }
  lines.push(`  Cluster coverage: ${report.rollup.clusterCoverage} clusters`);
  const top = report.rollup.topServedClusters
    .slice(0, 3)
    .map((c) => `${c.clusterId} (${fmtPct(c.pct)})`)
    .join(', ');
  if (top) lines.push(`  Top-served: ${top}`);
  const pathLines = Object.entries(report.rollup.pathologyCounts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} × ${n}`);
  if (pathLines.length > 0) lines.push(`  Pathologies: ${pathLines.join(', ')}`);

  return lines.join('\n');
}
