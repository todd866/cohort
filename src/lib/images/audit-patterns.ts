import type { Modality } from './types';

export interface VisualCuePattern {
  pattern: RegExp;
  modality?: Modality;
}

export const VISUAL_CUE_PATTERNS: VisualCuePattern[] = [
  { pattern: /\bshown\b/i },
  { pattern: /\bimage\b/i },
  { pattern: /\bphoto/i, modality: 'photo' },
  { pattern: /\brash\b/i, modality: 'derm' },
  { pattern: /\brhythm strip\b/i, modality: 'ecg' },
  { pattern: /\becg\b/i, modality: 'ecg' },
  { pattern: /\bx-?ray\b/i, modality: 'cxr' },
  { pattern: /\bcxr\b/i, modality: 'cxr' },
  { pattern: /\bct (scan|image|head|chest|abdo)/i, modality: 'ct' },
  { pattern: /\bmri\b/i, modality: 'mri' },
  { pattern: /\bultrasound\b/i, modality: 'us' },
  { pattern: /\botoscop/i, modality: 'otoscopy' },
  { pattern: /\bfundoscop/i, modality: 'fundoscopy' },
  { pattern: /\bgrowth chart\b/i, modality: 'other' },
  { pattern: /\bhistology\b/i, modality: 'histology' },
];
