import { z } from 'zod';

export const PROMPT_FIGURE_MAX_BYTES = 3_000_000;
export const PROMPT_FIGURE_MAX_PER_PAPER = 20;
export const PROMPT_FIGURE_PATH = /^\/practice-exam-images\/([a-f0-9]{64})\.(png|jpg|webp)$/;
const text = (max: number) => z.string().trim().min(1).max(max);
const https = z.string().url().max(2_000).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'source and licence URLs must use HTTPS');

/** Only neutral, immutable media identity belongs in a pre-answer delivery. */
const promptFigureFields = z.object({
  src: z.string().regex(PROMPT_FIGURE_PATH),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  alt: text(400),
  caption: text(400),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
}).strict();
const sameAsset = (figure: { src: string; sha256: string }) => figure.src.match(PROMPT_FIGURE_PATH)?.[1] === figure.sha256;
export const promptFigureViewSchema = promptFigureFields.refine(sameAsset, {
  message: 'prompt figure filename must equal the full asset SHA-256', path: ['src'],
});

/** Authored provenance remains available in the answer review and printed key. */
export const promptFigureSchema = promptFigureFields.extend({
  attribution: text(600),
  sourceUrl: https,
  license: text(100),
  licenseUrl: https,
}).strict().refine(sameAsset, { message: 'prompt figure filename must equal the full asset SHA-256', path: ['src'] });
export type PromptFigure = z.infer<typeof promptFigureSchema>;
export type PromptFigureView = z.infer<typeof promptFigureViewSchema>;

export function toPromptFigureView(figure: PromptFigure): PromptFigureView {
  return { src: figure.src, sha256: figure.sha256, alt: figure.alt, caption: figure.caption, width: figure.width, height: figure.height };
}
