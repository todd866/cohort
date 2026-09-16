/**
 * The source row's explicit prompt role is authoritative. Sidecar inference is
 * retained for legacy cards/questions whose role is null, so existing reviewed
 * diagnostic prompts do not move below the answer during the migration.
 */
export { itemImageIsPrompt as reviewImageIsPrompt } from '@/lib/figures/prompt-policy';
