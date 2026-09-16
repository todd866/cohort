import { z } from 'zod';
import type { ExamTargetDefinition } from './types';

const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const DOMAIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const evidenceRefSchema = z.object({
  role: z.enum(['taxonomy', 'weights', 'geometry', 'outcome', 'curriculum']),
  authority: z.enum([
    'official-assessment-report',
    'institution-practice',
    'specialty-society-practice',
    'official-curriculum',
    'internal-curation',
  ]),
  sourceId: z.string().min(1).regex(STABLE_ID).refine(
    (value) =>
      !value.startsWith('/')
      && !value.includes('..')
      && !value.toLowerCase().includes('.private'),
    'sourceId must be a stable logical id, not a private filesystem path',
  ),
  sourceDate: z.string().date().optional(),
  sha256: z.string().regex(SHA256),
  verbatim: z.boolean(),
  runtimeSafe: z.boolean(),
}).strict();

const reportingGroupSchema = z.object({
  code: z.string().regex(DOMAIN_ID),
  label: z.string().min(1),
  questionCount: z.number().int().positive(),
}).strict();

const domainSchema = z.object({
  code: z.string().regex(DOMAIN_ID),
  label: z.string().min(1),
  parentCode: z.string().regex(DOMAIN_ID).optional(),
  aliases: z.array(z.string().min(1)),
  questionCount: z.number().int().positive().optional(),
  anchorCount: z.number().int().nonnegative(),
  rawWeight: z.number().min(0).max(1),
  effectiveWeight: z.number().min(0).max(1),
  weightAuthority: z.enum(['official', 'proxy']),
  anchorSupport: z.enum(['sufficient', 'provisional', 'sparse', 'missing']),
  clinicallyCritical: z.boolean().optional(),
}).strict();

const influenceSchema = z.object({
  allocator: z.enum(['full', 'soft', 'shadow']),
  maxItemRankMove: z.number().int().nonnegative().max(5),
  conceptMultiplierMin: z.number().positive().max(2),
  conceptMultiplierMax: z.number().positive().max(2),
}).strict();

export const examTargetDefinitionSchema = z.object({
  schema: z.literal('md3.exam-target/v1'),
  targetId: z.string().min(1).regex(STABLE_ID).refine(
    (value) => !value.includes('@'),
    'targetId is the stable base id; revision belongs in the revision field',
  ),
  revision: z.number().int().positive(),
  rotation: z.enum(['critical-care', 'paam', 'cah', 'pwh']),
  servingStatus: z.enum(['shadow', 'limited', 'active', 'retired']),
  targetBasis: z.enum(['official', 'hybrid', 'proxy']),
  validFrom: z.string().date(),
  evidence: z.object({
    taxonomy: evidenceRefSchema,
    weights: evidenceRefSchema,
    geometry: z.array(evidenceRefSchema).min(1),
    outcomes: z.array(evidenceRefSchema),
    curriculum: z.array(evidenceRefSchema).min(1),
  }).strict(),
  reportingGroups: z.array(reportingGroupSchema).optional(),
  domains: z.array(domainSchema).min(1),
  influence: influenceSchema,
  scoringPolicyVersion: z.string().min(1).regex(STABLE_ID),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.number().int().positive(),
  anchorCorpusHash: z.string().regex(SHA256),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((target, ctx) => {
  const roleChecks: Array<[string, string]> = [
    ['taxonomy', target.evidence.taxonomy.role],
    ['weights', target.evidence.weights.role],
  ];
  for (const [expected, actual] of roleChecks) {
    if (expected !== actual) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', expected, 'role'],
        message: `expected evidence role ${expected}`,
      });
    }
  }
  for (const [key, refs] of [
    ['geometry', target.evidence.geometry],
    ['outcome', target.evidence.outcomes],
    ['curriculum', target.evidence.curriculum],
  ] as const) {
    refs.forEach((ref, index) => {
      if (ref.role !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', key, index, 'role'],
          message: `expected evidence role ${key}`,
        });
      }
    });
  }

  const domainIds = new Set<string>();
  const groupIds = new Set((target.reportingGroups ?? []).map((group) => group.code));
  for (const [index, domain] of target.domains.entries()) {
    if (domainIds.has(domain.code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domains', index, 'code'],
        message: `duplicate domain code ${domain.code}`,
      });
    }
    domainIds.add(domain.code);
    if (domain.parentCode && !groupIds.has(domain.parentCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domains', index, 'parentCode'],
        message: `unknown reporting group ${domain.parentCode}`,
      });
    }

    const expectedStatus = domain.anchorCount >= 3
      ? 'sufficient'
      : domain.anchorCount === 2
        ? 'provisional'
        : domain.anchorCount === 1
          ? 'sparse'
          : 'missing';
    if (domain.anchorSupport !== expectedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domains', index, 'anchorSupport'],
        message: `${domain.anchorCount} anchors require ${expectedStatus} anchor support`,
      });
    }
  }

  for (const [index, group] of (target.reportingGroups ?? []).entries()) {
    const childQuestionCount = target.domains
      .filter((domain) => domain.parentCode === group.code)
      .reduce((sum, domain) => sum + (domain.questionCount ?? 0), 0);
    if (childQuestionCount !== group.questionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reportingGroups', index, 'questionCount'],
        message:
          `reporting parent ${group.code} declares ${group.questionCount} questions; `
          + `schedulable leaves sum to ${childQuestionCount}`,
      });
    }
  }

  const weightSum = target.domains.reduce(
    (sum, domain) => sum + domain.effectiveWeight,
    0,
  );
  if (Math.abs(weightSum - 1) > 1e-9) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['domains'],
      message: `effective weights must sum to 1; received ${weightSum}`,
    });
  }

  const officialDomains = target.domains.filter(
    (domain) => domain.weightAuthority === 'official',
  );
  if (officialDomains.length > 0) {
    const totalQuestions = officialDomains.reduce(
      (sum, domain) => sum + (domain.questionCount ?? 0),
      0,
    );
    officialDomains.forEach((domain, index) => {
      const expected = (domain.questionCount ?? 0) / totalQuestions;
      if (
        domain.questionCount == null
        || Math.abs(domain.rawWeight - expected) > 1e-12
        || Math.abs(domain.effectiveWeight - expected) > 1e-12
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['domains', index, 'effectiveWeight'],
          message: 'official weights must be derived from integer question counts',
        });
      }
    });
  }

  const proxyDomains = target.domains.filter(
    (domain) => domain.weightAuthority === 'proxy',
  );
  if (proxyDomains.length > 0) {
    const totalAnchors = proxyDomains.reduce((sum, domain) => sum + domain.anchorCount, 0);
    const uniform = 1 / proxyDomains.length;
    proxyDomains.forEach((domain, index) => {
      const raw = domain.anchorCount / totalAnchors;
      const expected = 0.5 * raw + 0.5 * uniform;
      if (
        Math.abs(domain.rawWeight - raw) > 1e-12
        || Math.abs(domain.effectiveWeight - expected) > 1e-12
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['domains', index, 'effectiveWeight'],
          message: 'proxy weights must use 50% anchor share and 50% uniform shrinkage',
        });
      }
    });
  }

  if (target.targetBasis === 'proxy' && target.influence.allocator === 'full') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['influence', 'allocator'],
      message: 'proxy targets cannot use the full allocator',
    });
  }
  if (target.influence.conceptMultiplierMin > target.influence.conceptMultiplierMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['influence'],
      message: 'concept multiplier minimum cannot exceed maximum',
    });
  }
});

export function parseExamTargetDefinition(value: unknown): ExamTargetDefinition {
  return examTargetDefinitionSchema.parse(value) as ExamTargetDefinition;
}

export function examTargetVersionId(
  target: Pick<ExamTargetDefinition, 'targetId' | 'revision'>,
): string {
  return `${target.targetId}@${target.revision}`;
}
