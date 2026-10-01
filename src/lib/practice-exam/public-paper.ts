export const PUBLIC_PRACTICE_ATTEMPT_SCHEMA = 'md3-practice-exam-attempt/v1';
export interface PublicPracticePaperItem { id: string; topic: string; domain: string; task: string; answerIndex: number; options: readonly string[]; questionNumber?: number | null; }
export interface PublicPracticePaper { id: string; rotation: string; items: readonly PublicPracticePaperItem[]; }
export interface PublicPracticePaperListing { id: string; slug: string; title: string; }
export function loadPublicPracticePaper(_paperId: string): PublicPracticePaper | null { return null; }
export function listPublicPracticePapers(_rotation: string): readonly PublicPracticePaperListing[] { return []; }
