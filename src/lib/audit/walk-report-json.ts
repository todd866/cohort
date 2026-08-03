import type { WalkAuditReport } from './walk-types';

export function formatJsonReport(report: WalkAuditReport): string {
  return JSON.stringify(report, null, 2);
}
