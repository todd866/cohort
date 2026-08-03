import fs from 'node:fs';
import path from 'node:path';

export interface QuestionImageOverlay {
  imageUrl: string;
  imageCaption: string;
}

export type QuestionImageOverlayMap = Record<string, QuestionImageOverlay>;

export const DEFAULT_QUESTION_IMAGE_OVERLAY_PATH = path.join(
  process.cwd(),
  'content',
  'question-image-overlay.json',
);

function isQuestionImageOverlay(value: unknown): value is QuestionImageOverlay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.imageUrl === 'string'
    && candidate.imageUrl.length > 0
    && typeof candidate.imageCaption === 'string'
    && candidate.imageCaption.length > 0;
}

/**
 * Load the optional md3-owned overlay without making the private `content/`
 * tree a compile-time dependency. Clean FOSS checkouts intentionally have no
 * overlay file and therefore receive an empty map. A present but malformed
 * file still fails loudly rather than silently dropping authored images.
 */
export function loadQuestionImageOverlaysFromDisk(
  overlayPath = DEFAULT_QUESTION_IMAGE_OVERLAY_PATH,
): QuestionImageOverlayMap {
  if (!fs.existsSync(overlayPath)) return {};

  const parsed = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Question image overlay must be an object: ${overlayPath}`);
  }

  const overlays: QuestionImageOverlayMap = {};
  for (const [questionId, overlay] of Object.entries(parsed)) {
    if (!questionId || !isQuestionImageOverlay(overlay)) {
      throw new Error(`Invalid question image overlay entry '${questionId}' in ${overlayPath}`);
    }
    overlays[questionId] = overlay;
  }
  return overlays;
}

const QUESTION_IMAGE_OVERLAYS = loadQuestionImageOverlaysFromDisk();

type OverlayableQuestion = Record<string, unknown> & {
  id: string;
  imageUrl?: string | null;
  imageCaption?: string | null;
};

/**
 * md3-owned visual enrichment for question-bank sources that live in a sibling
 * repository. The authored bank remains canonical; an image already present
 * there always wins over this local overlay.
 */
export function applyQuestionImageOverlay(
  question: OverlayableQuestion,
  overlays: QuestionImageOverlayMap = QUESTION_IMAGE_OVERLAYS,
): OverlayableQuestion {
  if (question.imageUrl) return question;

  const overlay = overlays[question.id];
  if (!overlay) return question;

  return {
    ...question,
    imageUrl: overlay.imageUrl,
    imageCaption: overlay.imageCaption,
  };
}
