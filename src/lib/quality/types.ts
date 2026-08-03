/** Structured quality record for cards and questions.
 *  Fields are enums/structured, not free text — phase 2 uses these as manifold coordinates.
 *  See docs/designs/2026-02-01-study-item-quality-model.md
 */

export const UTILITY_TYPES = ['decision', 'discrimination', 'gate', 'framework'] as const;
export type UtilityType = typeof UTILITY_TYPES[number];

export const OPERATIONS = ['anchoring', 'connecting'] as const;
export type Operation = typeof OPERATIONS[number];

export const QUALITY_STATUSES = ['unaudited', 'pass', 'needs_fix', 'rejected'] as const;
export type QualityStatus = typeof QUALITY_STATUSES[number];

export const CHECK_STATUSES = ['pass', 'fail', 'na', 'unchecked'] as const;
export type CheckStatus = typeof CHECK_STATUSES[number];

export interface ItemQualityRecord {
  // Layer 1: Utility — "knowing this, the student can now ___"
  utilityType: UtilityType;
  enabledAction: string;    // Concrete verb: diagnose, treat, avoid, distinguish, escalate
  clinicalContext: string;  // Where this matters

  // Layer 2: Cognitive operation
  operation: Operation;
  connectedNodes?: string[];  // For 'connecting': which known concepts are linked

  // Layer 3: Flow
  activation: string;  // What mental model the stem invokes
  hops: number;        // 1 = recall, 2-3 = reasoning, 4+ = too complex
  target: string;      // What's retrieved
  direction: string;   // e.g. "disease->treatment", "treatment->disease"

  // Layer 4: Constraints (can be auto-checked)
  formOpacity: CheckStatus;
  formIssues: string[];
  distractorAdj: CheckStatus;    // 'na' for cloze cards
  distractorIssues: string[];

  // Audit status
  qualityStatus: QualityStatus;
  auditedBy?: string;
}

export function validateQualityRecord(record: ItemQualityRecord): string[] {
  const errors: string[] = [];

  if (!UTILITY_TYPES.includes(record.utilityType)) {
    errors.push(`utilityType must be one of: ${UTILITY_TYPES.join(', ')}`);
  }
  if (!record.enabledAction || record.enabledAction.trim() === '') {
    errors.push('enabledAction is required');
  }
  if (!record.clinicalContext || record.clinicalContext.trim() === '') {
    errors.push('clinicalContext is required');
  }
  if (!OPERATIONS.includes(record.operation)) {
    errors.push(`operation must be one of: ${OPERATIONS.join(', ')}`);
  }
  if (record.operation === 'connecting' && (!record.connectedNodes || record.connectedNodes.length === 0)) {
    errors.push('connectedNodes required when operation is connecting');
  }
  if (!record.activation || record.activation.trim() === '') {
    errors.push('activation is required');
  }
  if (record.hops > 3) {
    errors.push('hops > 3: consider breaking this item into smaller pieces');
  }
  if (!record.target || record.target.trim() === '') {
    errors.push('target is required');
  }
  if (!record.direction || record.direction.trim() === '') {
    errors.push('direction is required');
  }
  if (!CHECK_STATUSES.includes(record.formOpacity)) {
    errors.push(`formOpacity must be one of: ${CHECK_STATUSES.join(', ')}`);
  }
  if (!CHECK_STATUSES.includes(record.distractorAdj)) {
    errors.push(`distractorAdj must be one of: ${CHECK_STATUSES.join(', ')}`);
  }
  if (!QUALITY_STATUSES.includes(record.qualityStatus)) {
    errors.push(`qualityStatus must be one of: ${QUALITY_STATUSES.join(', ')}`);
  }

  return errors;
}
