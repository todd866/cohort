import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getOrCreateGuestUser } from '@/lib/guest-user';
import { prisma } from '@/lib/prisma';
import {
  AnswerValidationError,
  gradeAnswer,
  movesFromModuleNodes,
  parseAnswerRequest,
  type StoredOption,
} from '@/lib/gamsat/answer';

/**
 * Record one GAMSAT answer.
 *
 * NO SIGNUP WALL: a signed-out visitor gets a cookie-backed guest identity on
 * their first answer, so history accrues from the very first question and
 * `claim-guest-progress` can migrate it if they later sign in. `/gamsat` stays
 * a session rather than a funnel, and no response is lost to being anonymous.
 *
 * Correctness is decided from the stored question, never from the request.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseAnswerRequest(payload);
  } catch (error) {
    if (error instanceof AnswerValidationError) {
      return NextResponse.json({ error: 'invalid_request', detail: error.message }, { status: 400 });
    }
    throw error;
  }

  const question = await prisma.question.findFirst({
    where: { id: parsed.questionId, rotation: 'gamsat' },
    select: { id: true, options: true, moduleNodes: true, context: true },
  });
  if (!question) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let graded;
  try {
    graded = gradeAnswer(question.options as unknown as StoredOption[], parsed);
  } catch (error) {
    if (error instanceof AnswerValidationError) {
      return NextResponse.json({ error: 'invalid_request', detail: error.message }, { status: 400 });
    }
    throw error;
  }

  const session = await auth();
  const userId = session?.user?.id ?? (await getOrCreateGuestUser());

  // Repeat encounters are the point, not a conflict: each attempt is its own
  // row so the calibration corpus keeps first-look and repeat performance
  // distinguishable rather than overwriting one with the other.
  const attemptNumber = await prisma.questionResponse.count({
    where: { userId, questionId: question.id },
  }) + 1;

  try {
    await prisma.questionResponse.create({
      data: {
        userId,
        questionId: question.id,
        // A skip still records; '-' marks it, and selectedDisplayPosition
        // stays null so it never masquerades as a chosen option.
        selectedOption: graded.selectedLabel ?? '-',
        isCorrect: graded.isCorrect,
        responseTimeMs: graded.responseTimeMs,
        sessionType: 'practice',
        attemptNumber,
        correctDisplayPosition: graded.correctDisplayPosition,
        selectedDisplayPosition: graded.selectedDisplayPosition,
        confidence: graded.confidence,
      },
    });
  } catch {
    // A duplicate attemptNumber means a concurrent write won the race. The
    // learner's answer is already recorded; never fail their session over it.
  }

  return NextResponse.json({
    questionId: question.id,
    isCorrect: graded.isCorrect,
    correctLabel: graded.correctLabel,
    attemptNumber,
    moves: movesFromModuleNodes(question.moduleNodes),
    explanation: question.context,
  });
}
