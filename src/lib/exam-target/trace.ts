import { z } from 'zod';

const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_VERSION = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*@[1-9][0-9]*$/;
const DOMAIN_CODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const examTargetTraceSchema = z.object({
  schema: z.literal('md3.exam-target-trace/v1'),
  targetVersion: z.string().max(200).regex(TARGET_VERSION),
  domainCode: z.string().max(80).regex(DOMAIN_CODE).nullable().optional(),
  constraintCodes: z.array(z.enum([
    'protected_due',
    'protected_relearn',
    'protected_failure',
    'protected_scaffold',
    'discretionary',
    'fresh',
    'mastered',
    'unseen',
    'seen',
    'linkage_primary',
    'linkage_linked',
    'linkage_topic',
    'vector_ranked',
    'vector_unranked',
    'no_vector',
    'source_native',
    'source_cross_mapped',
    'requested_difficulty',
    'bank_preferred',
  ])).max(16),
  components: z.object({
    examRelevancePct: z.number().finite().min(0).max(1).nullable().optional(),
    examDomainWeight: z.number().finite().min(0).max(1).nullable().optional(),
    userDomainGap: z.number().finite().min(0).max(1).nullable().optional(),
    contentTargetScore: z.number().finite().min(0).max(1).nullable().optional(),
    personalizedTargetScore: z.number().finite().min(0).max(1).nullable().optional(),
    targetBoostDelta: z.number().finite().min(-5).max(0).nullable().optional(),
  }).strict(),
  policyDigest: z.string().regex(SHA256),
  candidateSetDigest: z.string().regex(SHA256),
}).strict();

export type ExamTargetTrace = z.infer<typeof examTargetTraceSchema>;
export const MAX_EXAM_TARGET_TRACE_BYTES = 4_096;

export function parseExamTargetTrace(value: unknown): ExamTargetTrace {
  const trace = examTargetTraceSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(trace)).byteLength > MAX_EXAM_TARGET_TRACE_BYTES) {
    throw new Error(`exam-target trace exceeds ${MAX_EXAM_TARGET_TRACE_BYTES} bytes`);
  }
  return trace;
}
