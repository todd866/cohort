import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isCohortHostname } from '@/lib/institution';
import { answerStep1Request } from '@/lib/usmle/step1-answer-request.server';
import { isReviewedStep1MediaSourcePageUrl } from '@/lib/usmle/step1-media-source.server';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Host',
};

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

const displayLabelSchema = z.string().regex(/^[A-Z]$/);
const publicAnswerSchema = z.object({
  deduped: z.boolean(),
  answer: z.object({
    deliveryId: z.string().min(1),
    questionId: z.string().min(1),
    selectedDisplayLabel: displayLabelSchema.nullable(),
    correctDisplayLabel: displayLabelSchema,
    isCorrect: z.boolean(),
    attemptNumber: z.number().int().positive(),
    explanation: z.string().nullable(),
    postAnswerAlt: z.string().trim().min(1).max(2_000).nullable(),
    postAnswerSourcePageUrl: z.string().trim().min(1).max(2_048).url().refine(
      isReviewedStep1MediaSourcePageUrl,
    ).nullable(),
    optionExplanations: z.array(z.object({
      label: displayLabelSchema,
      explanation: z.string().nullable(),
      misconception: z.string().nullable(),
    }).strip()),
    attribution: z.object({
      text: z.string(),
      licence: z.string(),
    }).strip(),
    citation: z.object({
      kind: z.enum(['reference', 'passage']),
      title: z.string(),
      publisher: z.string(),
      canonicalUrl: z.string(),
      attribution: z.string(),
      licence: z.object({ id: z.string(), url: z.string() }).strip(),
      passageLocator: z.string().nullable(),
      quote: z.string().optional(),
    }).strip().nullable(),
  }).strip(),
}).strip();

export async function POST(request: NextRequest) {
  if (!isCohortHostname(new URL(request.url).hostname)) {
    return json({ error: 'Not found' }, 404);
  }

  const upstream = await answerStep1Request(request, 'cohort');
  if (!upstream.ok) return upstream;

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: 'Invalid answer response' }, 502);
  }

  const parsed = publicAnswerSchema.safeParse(payload);
  if (!parsed.success) {
    return json({ error: 'Invalid answer response' }, 502);
  }

  const answer = parsed.data.answer;
  const publicAnswer = {
    deliveryId: answer.deliveryId,
    selectedDisplayLabel: answer.selectedDisplayLabel,
    correctDisplayLabel: answer.correctDisplayLabel,
    isCorrect: answer.isCorrect,
    attemptNumber: answer.attemptNumber,
    explanation: answer.explanation,
    postAnswerAlt: answer.postAnswerAlt,
    postAnswerSourcePageUrl: answer.postAnswerSourcePageUrl,
    optionExplanations: answer.optionExplanations,
    attribution: answer.attribution,
    citation: answer.citation,
  };
  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  headers.set('Vary', PRIVATE_HEADERS.Vary);
  headers.delete('content-length');
  headers.delete('content-encoding');

  return NextResponse.json(
    {
      deduped: parsed.data.deduped,
      answer: publicAnswer,
    },
    { status: upstream.status, headers },
  );
}
