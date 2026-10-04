import { z } from 'zod';
import type { CuratedQuestion, CuratedStatement } from './types';
import { buildStatementItemOptions, kTypeLetterFor, kTypeStem, normaliseFactKey } from './statement-items';

/**
 * A `*.statements.json` file holds exam-format statement items (Type X / NSA
 * Type 1 and NSA Type 2) for one rotation. Like a contrast set, it is expanded
 * at the top of the loader into ordinary questions, so every later stage —
 * validation, seeding, embedding — sees nothing new except `statements`, the
 * server-side record of each statement's truth, source and scaffold.
 */
export const STATEMENT_FILE_SUFFIX = '.statements.json';

const FACT_KEY = /^[^|]+\|[^|]+\|[^|]+$/;

const StatementSchema = z.object({
  text: z.string().trim().min(1),
  isTrue: z.boolean(),
  factKey: z.string().trim().regex(FACT_KEY, 'factKey must be "structure|relation|value"'),
  source: z.object({
    pdfPage: z.number().int().nonnegative(),
    printedPage: z.number().int().positive().nullable(),
    passage: z.string().trim().min(1),
  }),
  correction: z.string().trim().min(1).nullable(),
  conflictCheck: z.string().optional(),
  scaffoldTitle: z.string().trim().min(1, 'scaffoldTitle is required'),
  scaffold: z.string().trim().min(1, 'scaffold is required'),
});

const ItemSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  responseFormat: z.enum(['typeX', 'kType']),
  region: z.string().regex(/^[a-z0-9-]+$/),
  stem: z.string().trim().min(1),
  statements: z.array(StatementSchema).length(4),
  explanation: z.string().trim().min(1),
  // A spot (GSSE anatomy spots are 40% of its marks): the picture is the
  // prompt, its statements are about structures marked on it, and the caption
  // says where to look without naming anything.
  imageUrl: z.string().regex(/^\/figures\//, 'imageUrl must be a /figures/ path').optional(),
  imageCaption: z.string().trim().min(1).optional(),
  imageRole: z.literal('prompt').optional(),
}).refine((item) => !item.imageUrl || item.imageCaption, {
  message: 'imageCaption is required with imageUrl', path: ['imageCaption'],
}).refine((item) => !item.imageRole || item.imageUrl, {
  message: 'imageRole needs an imageUrl', path: ['imageRole'],
});

const FileSchema = z.object({
  rotation: z.string().trim().min(1),
  moduleNodes: z.array(z.string().trim().min(1)).min(1),
  exam: z.string().regex(/^[a-z0-9-]+$/),
  sourceBook: z.string().regex(/^[a-z0-9-]+$/),
  items: z.array(z.unknown()),
}).strict();

/** "False. <correction>" then the scaffold: the verdict, the fact, then the why. */
export function statementTeaching(s: Pick<CuratedStatement, 'isTrue' | 'correction' | 'scaffoldTitle' | 'scaffold'>): string {
  const verdict = s.isTrue ? 'True.' : `False. ${s.correction ?? ''}`.trim();
  return `${verdict}\n\n**${s.scaffoldTitle}.** ${s.scaffold}`;
}

export function expandStatementFile(parsed: unknown, filePath: string, errors: string[]): CuratedQuestion[] {
  const fileResult = FileSchema.safeParse(parsed);
  if (!fileResult.success) {
    for (const issue of fileResult.error.issues) errors.push(`${filePath}: ${issue.path.join('.')}: ${issue.message}`);
    return [];
  }
  const file = fileResult.data;
  const questions: CuratedQuestion[] = [];
  const factKeyOwner = new Map<string, string>();

  file.items.forEach((raw, index) => {
    const where = `${filePath}: items[${index}]`;
    const result = ItemSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) errors.push(`${where}.${issue.path.join('.')}: ${issue.message}`);
      return;
    }
    const item = result.data;
    const itemErrors: string[] = [];
    item.statements.forEach((s, i) => {
      if (!s.isTrue && !s.correction) itemErrors.push(`${where} (${item.slug}) statement ${i + 1}: a false statement needs a correction`);
      if (s.isTrue && s.correction) itemErrors.push(`${where} (${item.slug}) statement ${i + 1}: a true statement must not carry a correction`);
      const key = normaliseFactKey(s.factKey);
      const owner = factKeyOwner.get(key);
      if (owner) itemErrors.push(`${where} (${item.slug}) statement ${i + 1}: fact key ${key} already tested by ${owner}`);
      else factKeyOwner.set(key, `${item.slug}#${i + 1}`);
    });
    if (item.responseFormat === 'kType' && !kTypeLetterFor(item.statements.map((s) => s.isTrue))) {
      itemErrors.push(`${where} (${item.slug}): truth pattern is not on the K-type answer key`);
    }
    if (itemErrors.length > 0) {
      errors.push(...itemErrors);
      return;
    }

    const statements: CuratedStatement[] = item.statements.map((s) => ({
      text: s.text,
      isTrue: s.isTrue,
      factKey: normaliseFactKey(s.factKey),
      correction: s.correction,
      scaffoldTitle: s.scaffoldTitle,
      scaffold: s.scaffold,
      source: { book: file.sourceBook, ...s.source },
    }));
    // The teaching travels with the item, so the review screen (which grades
    // locally and works offline) can show it the moment an answer is revealed:
    // Type X in each statement's explanation, K-type in the context.
    const options = buildStatementItemOptions(item.responseFormat, statements).map((option, i) => (
      item.responseFormat === 'typeX' ? { ...option, explanation: statementTeaching(statements[i]) } : option
    ));
    const firstPage = statements.find((s) => s.source.printedPage !== null)?.source.printedPage;

    questions.push({
      id: `bank:${file.rotation}:${item.slug}:v1`,
      sourceFile: filePath,
      rotation: file.rotation as CuratedQuestion['rotation'],
      moduleNodes: file.moduleNodes,
      topics: [item.region, `exam:${file.exam}`],
      // No topic label fits a statement set; 'interpretation' (judging each
      // statement against the anatomy) is the nearest and keeps the union closed.
      questionType: 'interpretation',
      difficulty: 'hard',
      stem: item.responseFormat === 'kType' ? kTypeStem(item.stem, statements) : item.stem.trim(),
      options,
      context: item.responseFormat === 'kType'
        ? `${item.explanation}\n\n${statements.map((s, i) => `**${i + 1}.** ${statementTeaching(s)}`).join('\n\n')}`
        : item.explanation,
      cite: firstPage ? `${file.sourceBook}#p${firstPage}` : file.sourceBook,
      statements,
      ...(item.imageUrl
        ? { imageUrl: item.imageUrl, imageCaption: item.imageCaption, imageRole: item.imageRole ?? 'prompt' }
        : {}),
    });
  });

  return questions;
}
