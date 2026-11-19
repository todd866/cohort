import type { ClientImageMeta } from '@/lib/figures/types';
import { itemImageIsPrompt } from '@/lib/figures/prompt-policy';

/** The item's served figure, as the AI chat may show it beside a Talk answer. */
export interface ChatFigure {
  imageKey: string | null;
  src: string | null;
  meta?: ClientImageMeta;
  /** Only once revealed: a caption can name the finding. */
  caption: string | null;
  /** The figure is the question itself (visible before reveal). */
  prompt: boolean;
  revealed: boolean;
}

interface FigureItem {
  imageKey?: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageRole?: string | null;
  imageMeta?: ClientImageMeta;
  /** A practice-paper prompt figure has its own renderer; it is not offered to the chat. */
  promptFigure?: unknown;
  /** Public anatomy media has its own renderer and rights path; not offered to the chat. */
  publicAnatomyMedia?: unknown;
}

/**
 * Whether the figure on screen may appear in the chat, by the review surface's
 * own rule (CardItemView/McqItemView `figureMounted`): a prompt figure from the
 * start, any other figure only once the answer is out. CardImage's own
 * `showWhen` test is NOT enough: it lets a default `always` figure through
 * before reveal, and the figure can show the blanked finding.
 */
export function chatFigureFor(item: FigureItem, revealed: boolean, promptText: string | null | undefined): ChatFigure | null {
  if (item.promptFigure || item.publicAnatomyMedia || !(item.imageKey || item.imageUrl)) return null;
  const prompt = itemImageIsPrompt(item.imageRole, item.imageMeta, promptText);
  if (!prompt && !revealed) return null;
  return {
    imageKey: item.imageKey ?? null, src: item.imageUrl ?? null,
    ...(item.imageMeta ? { meta: item.imageMeta } : {}),
    caption: revealed ? item.imageCaption ?? null : null, prompt, revealed,
  };
}
