import type { Line, Phase, Station } from './station-types';

/**
 * "Say the bare minimum, but exactly the right things" — as numbers, so a
 * checker decides and not taste (.claude/rules/authoring-prompts-need-numeric-caps.md).
 * Anything longer belongs behind a line's `more`, or nowhere.
 */
export const CAPS = {
  do: 8,
  say: 15,
  linesPerPhase: 7,
  takeaway: 12,
  more: 40,
  redFlags: 3,
  redFlagWords: 10,
  present: 70,
} as const;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Every broken cap and dangling reference in a station; empty means valid. */
export function checkStationCaps(station: Station): string[] {
  const errors: string[] = [];
  const sourceIds = new Set(station.sources.map((source) => source.id));
  const seen = new Set<string>();

  const words = (where: string, text: string | undefined, cap: number) => {
    if (text === undefined) return;
    const n = wordCount(text);
    if (n > cap) errors.push(`${where}: ${n} words > ${cap}`);
  };

  const line = (where: string, l: Line) => {
    if (seen.has(l.id)) errors.push(`duplicate line id ${l.id}`);
    seen.add(l.id);
    const at = `${where}.lines[${l.id}]`;
    words(`${at}.do`, l.do, CAPS.do);
    words(`${at}.say`, l.say, CAPS.say);
    if (l.more) {
      words(`${at}.more`, l.more.body, CAPS.more);
      for (const id of l.more.sourceIds) {
        if (!sourceIds.has(id)) errors.push(`${at}: unknown source ${id}`);
      }
    }
  };

  const phase = (where: string, p: Phase) => {
    if (p.lines.length > CAPS.linesPerPhase) {
      errors.push(`${where}.lines: ${p.lines.length} > ${CAPS.linesPerPhase}`);
    }
    words(`${where}.takeaway`, p.takeaway, CAPS.takeaway);
    p.lines.forEach((l) => line(where, l));
  };

  station.phases.forEach((p, i) => phase(`phases[${i}]`, p));
  for (const [track, phases] of Object.entries(station.tracks ?? {})) {
    phases.forEach((p, i) => phase(`tracks.${track}[${i}]`, p));
  }
  station.close.forEach((l) => line('close', l));
  words('present', station.present, CAPS.present);
  if ((station.redFlags?.length ?? 0) > CAPS.redFlags) {
    errors.push(`redFlags: ${station.redFlags!.length} > ${CAPS.redFlags}`);
  }
  station.redFlags?.forEach((flag, i) => words(`redFlags[${i}]`, flag, CAPS.redFlagWords));
  return errors;
}
