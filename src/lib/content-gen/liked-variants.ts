import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { randomUUID } from 'crypto';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

const MAX_QUESTIONS_PER_CONCEPT = 8;

const GENERATION_PROMPT = `You are a medical education expert creating MCQ questions for spaced repetition.

Given a flashcard that a student liked (found useful), generate 1-2 NEW multiple-choice questions that test the SAME concept from a DIFFERENT angle.

Rules:
- Create clinical scenario-based questions (not just rephrasing the card)
- Each question needs 4 options (one correct)
- Include a brief explanation for the correct answer
- Match the clinical context of the rotation
- Difficulty should be 'easy', 'medium', or 'hard'
- questionType should be one of: 'diagnosis', 'next-step', 'mechanism', 'calculation', 'management'

Return a JSON array:
[{
  "stem": "A 65-year-old patient presents to ED with...",
  "options": [
    {"text": "Option A", "isCorrect": false},
    {"text": "Option B", "isCorrect": true},
    {"text": "Option C", "isCorrect": false},
    {"text": "Option D", "isCorrect": false}
  ],
  "explanation": "Why the correct answer is correct...",
  "questionType": "management",
  "difficulty": "medium"
}]`;

interface GeneratedMCQ {
  stem: string;
  options: Array<{ text: string; isCorrect: boolean }>;
  explanation: string;
  questionType: string;
  difficulty: string;
}

export async function generateLikedVariants(cardId: string): Promise<string[]> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: {
      id: true,
      front: true,
      back: true,
      context: true,
      conceptId: true,
      rotation: true,
      week: true,
      topics: true,
      annotations: true,
    },
  });

  if (!card) return [];
  const [deliverableCard] = await filterDeliverableReinforcementCardRows([card], {
    logContext: { transport: 'liked-variant-generation' },
  });
  if (!deliverableCard) return [];

  if (!deliverableCard.conceptId) {
    logger.info('Skipping liked variant generation: no conceptId', { cardId });
    return [];
  }

  const annotations = (deliverableCard.annotations as Record<string, unknown>) ?? {};
  if (annotations.likedVariantGeneratedAt) {
    logger.info('Skipping liked variant generation: already generated', {
      cardId,
    });
    return [];
  }

  const questionCount = await prisma.question.count({
    where: { concepts: { some: { conceptId: deliverableCard.conceptId } } },
  });

  if (questionCount >= MAX_QUESTIONS_PER_CONCEPT) {
    logger.info(
      'Skipping liked variant generation: concept has enough questions',
      {
        cardId,
        conceptId: deliverableCard.conceptId,
        questionCount,
      }
    );
    return [];
  }

  const anthropic = new Anthropic();
  const cardContent = `Card front: ${deliverableCard.front}\nCard back: ${deliverableCard.back}${deliverableCard.context ? `\nContext: ${deliverableCard.context}` : ''}\nTopics: ${deliverableCard.topics.join(', ')}\nRotation: ${deliverableCard.rotation}`;

  let mcqs: GeneratedMCQ[];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `${GENERATION_PROMPT}\n\nLiked card:\n${cardContent}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.error('Failed to parse MCQ generation response', { cardId });
      return [];
    }

    mcqs = JSON.parse(jsonMatch[0]);
    mcqs = mcqs.slice(0, 2);
  } catch (error) {
    logger.error('MCQ generation failed', {
      cardId,
      error: String(error),
    });
    return [];
  }

  const variantGroupId = randomUUID();
  const createdIds: string[] = [];

  for (const mcq of mcqs) {
    if (!mcq.stem || !mcq.options || mcq.options.length < 4) continue;
    if (!mcq.options.some((o) => o.isCorrect)) continue;

    const labeledOptions = mcq.options.map((opt, i) => ({
      label: String.fromCharCode(65 + i),
      text: opt.text,
      isCorrect: opt.isCorrect,
    }));

    const question = await prisma.question.create({
      data: {
        stem: mcq.stem,
        options: labeledOptions,
        context: mcq.explanation || null,
        rotation: deliverableCard.rotation,
        week: deliverableCard.week,
        topics: deliverableCard.topics,
        source: 'ai-liked-variant',
        questionType: mcq.questionType || 'management',
        difficulty: mcq.difficulty || 'medium',
        variantGroupId,
        variantType: 'different-scenario',
        contentState: 'raw',
      },
    });

    await prisma.questionConcept.create({
      data: {
        questionId: question.id,
        conceptId: deliverableCard.conceptId,
        isPrimary: true,
      },
    });

    createdIds.push(question.id);
  }

  if (createdIds.length > 0) {
    await prisma.card.update({
      where: { id: cardId },
      data: {
        annotations: {
          ...annotations,
          likedVariantGeneratedAt: new Date().toISOString(),
        },
      },
    });

    logger.info('Generated liked card variants', {
      cardId,
      conceptId: deliverableCard.conceptId,
      questionIds: createdIds,
    });
  }

  return createdIds;
}
