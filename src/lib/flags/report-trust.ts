/**
 * Trust-boundary helpers for human-authored content reports.
 *
 * Raw reporter prose is retained only for an authenticated human reviewer.
 * Agent-operated workflows get a structured reason immediately and may get a
 * separately authored summary only after explicit admin approval.
 */

export const REPORT_TRUST_STATES = [
  'trusted',
  'structured',
  'quarantined',
  'approved',
  'rejected',
] as const;

export type ReportTrustState = (typeof REPORT_TRUST_STATES)[number];

const HUMAN_REPORTER_TYPES = new Set(['user', 'external', 'external-anki', 'anonymous']);

export const STRUCTURED_FLAG_REASONS = [
  'Context',
  'Formatting',
  'Needs Image',
  'Giveaway',
  'Rewrite',
  'Length Bias',
  'Acronym',
  'Too Long',
  'Other',
  'Too Easy',
  'Confusing',
  'TLA',
  'Irrelevant',
  'Incorrect',
  'Outdated',
  'Typo',
] as const;

export type StructuredFlagReason = (typeof STRUCTURED_FLAG_REASONS)[number];

const STRUCTURED_REASON_SET = new Set<string>(STRUCTURED_FLAG_REASONS);
const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Non-global twin of CONTROL_CHARACTERS: `.test()` on a /g regex is stateful
// (it advances lastIndex) and would make the prefilter non-deterministic across
// calls. This one is safe to `.test()`.
const HAS_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// Format effectors — bidi overrides, zero-width chars, word-joiner, BOM. Never
// legitimate in a flag note: they split a banned token past the INSTRUCTION_MARKERS
// denylist ("ig<ZWSP>nore") and let displayed text differ from logical text (RLO
// spoofing). Rejected by the prefilter and stripped from any released summary
// (adversarial review 2026-07-11, Findings 2 & 3).
const FORMAT_EFFECTORS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const HAS_FORMAT_EFFECTOR = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;

/**
 * A real flag note is a short phrase ("image is broken", "answer seems wrong").
 * A wall of text is either not a flag or an injection payload padded to bury a
 * marker, so the screener refuses to send it to the model at all.
 */
export const SCREEN_MAX_LENGTH = 600;
const INSTRUCTION_MARKERS = /(?:ignore\s+(?:all\s+|any\s+)?(?:previous|prior)\s+instructions|(?:^|[\n\r\t\u2028\u2029])\s*(?:system|assistant|developer)\s*:|<\/?(?:system|assistant|developer)\b|```)/i;

export function normalizeQuarantinedMessage(message: string | null | undefined): string | null {
  const trimmed = message?.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

export function trustStateForReporterMessage(message: string | null | undefined): ReportTrustState {
  return normalizeQuarantinedMessage(message) ? 'quarantined' : 'structured';
}

/** Who wrote the report. Trust is a property of the reporter, not of the prose. */
export interface Reporter {
  isAdmin: boolean;
}

export interface TrustDecision {
  state: ReportTrustState;
  /** Set only when the decision auto-approves; safe for agent workflows. */
  approvedSummary?: string;
  trustReviewedBy?: string;
  trustReviewedAt?: Date;
}

/**
 * Decide a report's trust state from WHO sent it, not merely whether it has text.
 *
 * The first cut quarantined every non-empty message, so the repo owner's own
 * "broken image" note was handled exactly like a hostile payload — and since
 * `agentVisibleFeedback` only releases prose in the `approved` state, it stayed
 * invisible to every agent-operated script.
 *
 * An admin's note is auto-approved into the same `approved` lifecycle a human
 * reviewer would use, so nothing downstream changes. Identity does NOT bypass
 * the injection scan: `validateApprovedSummary` still rejects instruction
 * markers, and a rejected admin note falls back to quarantine. Everyone else
 * stays quarantined, awaiting a reviewer or a screener.
 */
export function trustDecisionForReport(
  message: string | null | undefined,
  reporter: Reporter,
): TrustDecision {
  const normalized = normalizeQuarantinedMessage(message);
  if (!normalized) return { state: 'structured' };
  if (!reporter.isAdmin) return { state: 'quarantined' };

  // Not validateApprovedSummary(): its verbatim-copy rule exists to stop a human
  // reviewer pasting untrusted prose back out of quarantine. An admin's own note
  // IS the trusted content, so copying it is the point. The safety checks that
  // still apply — length and instruction markers — are applied directly.
  const sanitized = sanitizeApprovedSummary(normalized);
  if (sanitized.length < 3) return { state: 'quarantined' };
  if (INSTRUCTION_MARKERS.test(sanitized)) return { state: 'quarantined' };

  return {
    state: 'approved',
    approvedSummary: sanitized,
    trustReviewedBy: 'auto:admin',
    trustReviewedAt: new Date(),
  };
}

/** Normalize admin-authored text both on write and again on agent read. */
export function sanitizeApprovedSummary(summary: string): string {
  // Strip format effectors too, so a de-obfuscated instruction ("ig<ZWSP>nore")
  // is exposed to the INSTRUCTION_MARKERS check in validateApprovedSummary, and
  // no bidi/zero-width char survives into released prose or the /x/flags UI.
  return summary.replace(CONTROL_CHARACTERS, '').replace(FORMAT_EFFECTORS, '').trim().slice(0, 500);
}

export function validateApprovedSummary(summary: string, quarantinedMessage: string | null | undefined): {
  valid: boolean;
  summary: string;
  reason?: string;
} {
  const sanitized = sanitizeApprovedSummary(summary);
  if (sanitized.length < 3) {
    return { valid: false, summary: sanitized, reason: 'Summary must contain at least 3 characters' };
  }
  if (INSTRUCTION_MARKERS.test(sanitized)) {
    return { valid: false, summary: sanitized, reason: 'Summary contains instruction-like text' };
  }
  const raw = normalizeQuarantinedMessage(quarantinedMessage);
  if (raw && sanitized === sanitizeApprovedSummary(raw)) {
    return { valid: false, summary: sanitized, reason: 'Summary must be separately authored, not copied verbatim' };
  }
  return { valid: true, summary: sanitized };
}

export function safeIdentifierForAgent(value: string): string {
  return /^(?:[A-Za-z0-9][A-Za-z0-9:_./-]*|\/[A-Za-z0-9?&=_%+.,:/-]*)$/.test(value)
    ? value
    : '[invalid identifier quarantined]';
}

interface AgentVisibleFeedbackInput {
  issueType: string;
  metadata: unknown;
  reportTrustState: string | null | undefined;
  approvedSummary: string | null | undefined;
  trustReviewedAt: Date | string | null | undefined;
  trustReviewedBy: string | null | undefined;
}

export interface AgentVisibleFeedback {
  reporterType: string;
  reason: string;
  summary: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeIssueCode(issueType: string): string {
  return SAFE_CODE.test(issueType) ? issueType : 'other';
}

/**
 * Return only feedback that is safe for an automated/agent-operated workflow.
 * Human reports fail closed even if a legacy row still contains metadata.message.
 */
export function agentVisibleFeedback(input: AgentVisibleFeedbackInput): AgentVisibleFeedback {
  const metadata = record(input.metadata);
  const reporterType = typeof metadata.reporterType === 'string'
    ? metadata.reporterType
    : 'system';
  const humanAuthored = HUMAN_REPORTER_TYPES.has(reporterType)
    || input.reportTrustState !== 'trusted';

  if (humanAuthored) {
    const rawReason = typeof metadata.reason === 'string' ? metadata.reason : '';
    const reason = STRUCTURED_REASON_SET.has(rawReason)
      ? rawReason
      : safeIssueCode(input.issueType);
    const hasCompleteApproval = input.reportTrustState === 'approved'
      && Boolean(input.trustReviewedAt)
      && Boolean(input.trustReviewedBy);
    const summary = hasCompleteApproval && input.approvedSummary
      ? sanitizeApprovedSummary(input.approvedSummary)
      : '';
    return { reporterType, reason, summary: summary || null };
  }

  const reason = typeof metadata.reason === 'string'
    ? metadata.reason.slice(0, 100)
    : safeIssueCode(input.issueType);
  const message = typeof metadata.message === 'string'
    ? metadata.message.trim().slice(0, 500)
    : '';
  return { reporterType, reason, summary: message || null };
}

// ---------------------------------------------------------------------------
// LLM flag screener
//
// A non-admin report stays `quarantined` until a human reviews it. The screener
// lets an LLM do that review off the request path (script/cron/morning-check),
// promoting the flag to `approved` (with a model-authored summary) or `rejected`
// so reports from every learner, including anonymous users, reach triage. The screener is itself an
// injection target, so these pure helpers enforce the guards; the actual model
// call and DB writes live in scripts/audit/screen-flags.ts.
// ---------------------------------------------------------------------------

export type ScreenerVerdict = {
  verdict: 'approve' | 'reject' | 'unsure';
  /** The model's OWN summary — never the raw note copied through. */
  summary?: string;
  /** A short reason, for reject/unsure. */
  reason?: string;
};

export type ScreenPrefilterResult =
  | { decision: 'reject'; reason: string }
  | { decision: 'pass'; normalized: string };

/**
 * Deterministic gate that runs BEFORE the model and may only REJECT. It never
 * approves — approval is only ever the model's call behind re-validation. It
 * exists to (a) drop obvious non-reports and (b) keep instruction-shaped or
 * obfuscated payloads away from the model entirely.
 */
export function screenPrefilter(message: string | null | undefined): ScreenPrefilterResult {
  const normalized = normalizeQuarantinedMessage(message);
  if (!normalized) return { decision: 'reject', reason: 'empty' };
  if (HAS_CONTROL_CHARACTER.test(normalized)) return { decision: 'reject', reason: 'control-characters' };
  if (HAS_FORMAT_EFFECTOR.test(normalized)) return { decision: 'reject', reason: 'format-effectors' };
  if (normalized.length > SCREEN_MAX_LENGTH) return { decision: 'reject', reason: 'too-long' };
  if (INSTRUCTION_MARKERS.test(normalized)) return { decision: 'reject', reason: 'instruction-markers' };
  return { decision: 'pass', normalized };
}

export interface ScreenedDecision {
  /** 'approved' | 'rejected' | 'quarantined' — never 'trusted'. */
  state: ReportTrustState;
  approvedSummary?: string;
  trustReviewedBy?: string;
  trustReviewedAt?: Date;
  /** Whether the flag's trust state should actually be written. */
  changed: boolean;
}

/**
 * Turn a model verdict into a trust decision, behind the re-validation guard.
 *
 * The strongest state the screener can assign is `approved`, never `trusted`.
 * An `approve` verdict is honoured ONLY if the model authored a summary that
 * passes `validateApprovedSummary` — which rejects too-short, instruction-shaped,
 * or verbatim-copied summaries. Anything else (reject stays reject; unsure, a
 * missing/invalid summary) leaves the flag `quarantined` for `/x/flags`, so a
 * failure mode always falls back to a human rather than mislabelling a report.
 */
export function decideScreenedReport(
  normalized: string,
  verdict: ScreenerVerdict,
  model: string,
): ScreenedDecision {
  const reviewer = `llm-screener:${model}`;

  if (verdict.verdict === 'reject') {
    return { state: 'rejected', trustReviewedBy: reviewer, trustReviewedAt: new Date(), changed: true };
  }

  if (verdict.verdict === 'approve') {
    if (!verdict.summary) return { state: 'quarantined', changed: false };
    const validated = validateApprovedSummary(verdict.summary, normalized);
    if (!validated.valid) return { state: 'quarantined', changed: false };
    return {
      state: 'approved',
      approvedSummary: validated.summary,
      trustReviewedBy: reviewer,
      trustReviewedAt: new Date(),
      changed: true,
    };
  }

  // 'unsure' or any unexpected value → keep quarantined for a human.
  return { state: 'quarantined', changed: false };
}
