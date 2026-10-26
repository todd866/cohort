import { POPULATIONS, STATION_AUDIENCES, STATION_KINDS, type Line, type Phase, type Station } from './station-types';

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
  practiceInstruction: 20,
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
  words('practiceInstructions.markingRule', station.practiceInstructions?.markingRule, CAPS.practiceInstruction);
  words('practiceInstructions.completionReminder', station.practiceInstructions?.completionReminder, CAPS.practiceInstruction);
  words('present', station.present, CAPS.present);
  if ((station.redFlags?.length ?? 0) > CAPS.redFlags) {
    errors.push(`redFlags: ${station.redFlags!.length} > ${CAPS.redFlags}`);
  }
  station.redFlags?.forEach((flag, i) => words(`redFlags[${i}]`, flag, CAPS.redFlagWords));
  return errors;
}

/**
 * The station schema, checked at run time: the JSON is cast to Station on
 * import, so nothing else stops a mistyped kind, an unknown audience (which
 * would silently hide the station from everyone) or a line with no text.
 * Empty means valid.
 */
export function checkStationShape(station: Station): string[] {
  const errors: string[] = [];
  const text = (where: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) errors.push(`${where}: empty`);
  };
  text('id', station.id);
  text('title', station.title);
  text('task', station.task);
  if (station.practiceInstructions !== undefined) {
    if (!station.practiceInstructions || typeof station.practiceInstructions !== 'object') {
      errors.push('practiceInstructions: expected object');
    } else {
      text('practiceInstructions.markingRule', station.practiceInstructions.markingRule);
      text('practiceInstructions.completionReminder', station.practiceInstructions.completionReminder);
    }
  }
  if (!STATION_KINDS.includes(station.kind)) errors.push(`kind: ${station.kind}`);
  if (!Array.isArray(station.population) || station.population.length === 0) errors.push('population: empty');
  for (const p of station.population ?? []) if (!POPULATIONS.includes(p)) errors.push(`population: ${p}`);
  if (!(typeof station.minutes === 'number' && station.minutes > 0)) errors.push(`minutes: ${station.minutes}`);
  for (const a of station.audiences ?? []) {
    if (!(STATION_AUDIENCES as readonly string[]).includes(a)) errors.push(`audiences: ${a}`);
  }
  text('review.rotation', station.review?.rotation);
  if (!station.review?.topics?.length) errors.push('review.topics: empty');
  if (!station.sources?.length) errors.push('sources: empty');
  for (const s of station.sources ?? []) {
    text(`sources[${s.id}].id`, s.id);
    text(`sources[${s.id}].title`, s.title);
  }

  const line = (where: string, l: Line) => {
    text(`${where}.id`, l.id);
    text(`${where}.do`, l.do);
    if (l.to !== undefined && l.to !== 'patient' && l.to !== 'examiner') errors.push(`${where}.to: ${l.to}`);
    if (l.say !== undefined) text(`${where}.say`, l.say);
    if (l.more) text(`${where}.more.body`, l.more.body);
  };
  const phase = (where: string, p: Phase) => {
    text(`${where}.name`, p.name);
    text(`${where}.takeaway`, p.takeaway);
    if (!p.lines?.length) errors.push(`${where}.lines: empty`);
    (p.lines ?? []).forEach((l, i) => line(`${where}.lines[${i}]`, l));
  };
  if (!station.phases?.length) errors.push('phases: empty');
  (station.phases ?? []).forEach((p, i) => phase(`phases[${i}]`, p));
  for (const [track, phases] of Object.entries(station.tracks ?? {})) {
    phases.forEach((p, i) => phase(`tracks.${track}[${i}]`, p));
  }
  (station.close ?? []).forEach((l, i) => line(`close[${i}]`, l));
  for (const v of station.viva ?? []) {
    text('viva.q', v.q);
    text('viva.a', v.a);
  }
  return errors;
}
