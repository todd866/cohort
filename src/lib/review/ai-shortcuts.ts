/**
 * Review keys for the AI controls (owner, 18 Nov 2026: T toggles Talk; the
 * text chat moved from T to C). One place, so the handler, the control
 * labels and the shortcuts sheet cannot disagree.
 */
export const TALK_SHORTCUT = 'T';
export const CHAT_SHORTCUT = 'C';

/** True for the plain letter (either case), never with a modifier other than Shift. */
export function isShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, shortcut: string): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toUpperCase() === shortcut;
}

let talkKeyAt = -Infinity;
/** The T key just started or stopped Talk: the voice record counts key toggles. */
export function noteTalkShortcut(nowMs = Date.now()): void { talkKeyAt = nowMs; }
export function talkShortcutRecent(nowMs = Date.now()): boolean { return nowMs - talkKeyAt < 2_000; }
