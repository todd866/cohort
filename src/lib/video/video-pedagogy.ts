import { z } from 'zod';

export const videoPedagogySchema = z.object({
  pedagogicalSummary: z.string().min(1),
  placementRationale: z.string().min(1),
  tone: z.enum(['educational', 'meme']),
  primaryIntent: z.enum(['teaching', 'mixed', 'entertainment']),
  teachingFormat: z.enum([
    'explanation',
    'demonstration',
    'case-based',
    'quiz',
    'reaction',
    'story',
    'meme',
  ]),
  learnerLevel: z.enum(['novice', 'intermediate', 'advanced']),
  complexityTier: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  pedagogicalDensity: z.number().min(0).max(1),
  hookStrength: z.number().min(0).max(1),
  contextRequired: z.number().min(0).max(1),
  clinicalUtility: z.number().min(0).max(1),
  feedRole: z.enum([
    'hook',
    'core-teach',
    'reinforcement',
    'case-challenge',
    'light-relief',
  ]),
  keyTakeaways: z.array(z.string()),
  prerequisites: z.array(z.string()),
  keyConcepts: z.array(z.string()),
  embeddingText: z.string().min(1),
  confidence: z.number().min(0).max(1),
  generatorVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
});

export type VideoPedagogy = z.infer<typeof videoPedagogySchema>;

export function materializeVideoPedagogy(pedagogy: VideoPedagogy): {
  tone: VideoPedagogy['tone'];
  complexity: VideoPedagogy['complexityTier'];
} {
  return {
    tone: pedagogy.tone,
    complexity: pedagogy.complexityTier,
  };
}
