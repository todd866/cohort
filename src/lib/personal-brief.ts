/**
 * Personal course brief — the single-user "where do I need to be, when, and what
 * do I need to know on arrival" model behind /brief.
 *
 * Everything here is PURE and date-string based. Dates are plain `YYYY-MM-DD`
 * and are compared as UTC-anchored days, so a user in Australia/Sydney and a
 * Vercel function in UTC agree on which day it is. Never introduce `new Date()`
 * with a local-time constructor into this module — that reintroduces the
 * off-by-one that makes "today" wrong for half the day.
 *
 * The data is authored by the morning-check agent into
 * an operator-supplied course brief. No authored brief data ships with the
 * public source distribution.
 */
import type { ReviewIntent } from '@/lib/review/review-intent';

export type BlockPhase = 'before' | 'during' | 'after';
export type WbaStatus = 'not-started' | 'in-progress' | 'submitted' | 'done';
export type WbaUrgency = 'done' | 'overdue' | 'due-soon' | 'upcoming';
export type WatchStatus = 'pending' | 'action-required' | 'resolved';
export type DueSource = 'agreed' | 'conflict' | 'assumed';
export type BriefEventKind = 'duty' | 'wba' | 'deadline' | 'harvested' | 'action';

export interface BriefSource {
  id: string;
  label: string;
  url: string;
}

export interface WayfindingPage {
  label: string;
  url: string;
}

export interface BlockSite {
  name: string;
  shortName: string;
  note: string;
  wayfindingPages: WayfindingPage[];
}

export interface BlockContact {
  role: string;
  name: string;
  email: string;
}

export interface BlockMeta {
  id: string;
  rotationId: string;
  name: string;
  term: string;
  startDate: string;
  endDate: string;
  orientationDate: string;
  examDate: string;
  examLabel: string;
  homeClinicalSchool: string;
  site: BlockSite;
  contacts: BlockContact[];
}

export interface DailyAnchor {
  time: string;
  what: string;
  where: string;
  days: string;
}

export interface WeeklyFixture {
  day: string;
  time: string;
  what: string;
  where: string;
}

export interface AttachmentContact {
  role: string;
  name: string;
  email?: string;
}

export interface Attachment {
  label: string;
  startDate: string;
  endDate: string;
  weeks: number[];
  reviewTopics: string[];
  location?: string;
  /** `HH:MM` the attachment expects you on the floor. */
  firstDayStart?: string;
  source?: string;
  dailyAnchors?: DailyAnchor[];
  weeklyFixtures?: WeeklyFixture[];
  contacts?: AttachmentContact[];
  note?: string;
}

export interface CommuteOption {
  mode: string;
  minutes: number;
  /** Human range where the point estimate is known to be optimistic. */
  minutesRealistic?: string;
  distanceKm?: number;
  route: string;
  caveats: string[];
  verified: string;
}

export interface CostLine {
  item: string;
  unit: number | null;
  unitNote: string;
  days: number;
  total: number | null;
  confidence: 'verified' | 'estimated' | 'unknown';
}

export interface CostModel {
  clinicalDays: number;
  clinicalDaysBasis: string;
  verified: string;
  lines: CostLine[];
  /** Sum of the lines we can actually price. Excludes `unknown` lines. */
  blockTotalKnown: number;
  headline: string;
}

export interface CheaperOption {
  option: string;
  detail: string;
  confidence: string;
}

export interface ParkingOption {
  id: string;
  label: string;
  costPerDay: number | null;
  blockCost: number | null;
  walkMinutes: number | null;
  risk: string;
  verdict: string;
}

export interface ParkingDecision {
  framing: string;
  fineAmount: number;
  fineConfidence: string;
  options: ParkingOption[];
  recommendation: string;
}

export interface Commute {
  origin: string;
  destination: string;
  options: CommuteOption[];
  returnTrip?: { title: string; detail: string; source?: string };
  assumedMode?: string;
  assumedModeReason?: string;
  costModel?: CostModel;
  parkingDecision?: ParkingDecision;
  cheaperOptions?: CheaperOption[];
  note?: string;
  openQuestions?: string[];
}

export interface CampusLocation {
  name: string;
  where: string;
  phone?: string;
  usedFor: string;
}

export interface BriefWeek {
  week: number;
  startDate: string;
  endDate: string;
  canvasTopics: string[];
  md3Weeks: number[];
  note?: string;
}

export interface PrepResource {
  label: string;
  url: string;
}

export interface DueConflict {
  a: { value: string; source: string };
  b: { value: string; source: string };
  resolution: string;
}

export interface Wba {
  id: string;
  number: number;
  title: string;
  format: 'observed-practical' | 'written-assignment' | 'observed-clinical' | 'clinical-exam';
  status: WbaStatus;
  dueWeek: number;
  dueDate: string;
  dueTime: string;
  dueSource: DueSource;
  dueConflict?: DueConflict;
  prepTopics: string[];
  prepResources: PrepResource[];
  /** Explicit Review deep-link. Omit when no md3 preparation maps cleanly. */
  reviewIntent?: ReviewIntent;
  note?: string;
}

export interface Deadline {
  title: string;
  dueDate: string;
  where: string;
  kind: string;
  durationMin?: number;
  readingMin?: number;
  /** Explicit Review deep-link. Deadlines never inherit the block rotation. */
  reviewIntent?: ReviewIntent;
}

export interface ArrivalFact {
  tag: string;
  title: string;
  detail: string;
}

export interface WatchItem {
  item: string;
  status: WatchStatus;
  source: string;
  expectedBy?: string;
  note?: string;
}

export interface PreArrivalItem {
  title: string;
  source: string;
  dueBy: string;
}

export interface ClinicalAttachmentForms {
  requirement: string;
  submitTo: string;
  dueDate: string;
  note?: string;
}

export interface WbaRules {
  attempts: number;
  attemptsNote: string;
  missedDeadlineNote: string;
  assessorMinimum: string;
  portfolio: string;
  portfolioUrl: string;
}

/** One-shot / harvested timeline row authored into the brief JSON. */
export interface HarvestedBriefEvent {
  id: string;
  kind?: BriefEventKind;
  title: string;
  date: string;
  time?: string;
  where?: string;
  sources?: string[];
  prepTopics?: string[];
  md3Weeks?: number[];
  /** Explicit Review deep-link; absence means Details only. */
  reviewIntent?: ReviewIntent;
  note?: string;
}

export type BriefHarvestSourceStatus = 'fresh' | 'degraded' | 'unavailable';

export interface BriefHarvestSourceState {
  sourceId: string;
  checkedAt: string;
  status: BriefHarvestSourceStatus;
  note?: string;
}

export interface BriefHarvestTombstone {
  eventId: string;
  removedAt: string;
  sourceId: string;
  reason: string;
}

export interface BriefHarvestCorrectionRecord {
  eventId: string;
  correctedAt: string;
  sourceId: string;
  reason: string;
}

export interface BriefHarvestState {
  schemaVersion: number;
  deliveredAt: string;
  sources: BriefHarvestSourceState[];
  tombstones: BriefHarvestTombstone[];
  corrections: BriefHarvestCorrectionRecord[];
}

export interface CourseBrief {
  schemaVersion: number;
  /** Immutable database User.id allowed to receive this private dossier. */
  ownerUserId: string;
  updatedAt: string;
  sources: BriefSource[];
  block: BlockMeta;
  commute?: Commute;
  campusLocations?: CampusLocation[];
  attachments: Attachment[];
  weeks: BriefWeek[];
  wbas: Wba[];
  wbaRules?: WbaRules;
  clinicalAttachmentForms?: ClinicalAttachmentForms;
  preArrival: PreArrivalItem[];
  deadlines: Deadline[];
  arrivalFacts: ArrivalFact[];
  watchlist: WatchItem[];
  /** Optional AI-harvested / user-entered one-shots (duties still derive from anchors). */
  events?: HarvestedBriefEvent[];
  /** Durable delivery ledger for source freshness, removals and forced corrections. */
  harvest?: BriefHarvestState;
  noiseSenders?: string[];
  noiseSubjects?: string[];
}

export interface BriefEventWhen {
  date: string;
  /** Exact 24-hour clock only. */
  time?: string;
  /** Human schedule label when the source is approximate (`AM`, `PM`, `varies`). */
  timeLabel?: string;
}

export interface BriefEvent {
  id: string;
  kind: BriefEventKind;
  title: string;
  when: BriefEventWhen;
  where?: string;
  leaveBy?: string;
  prepTopics: string[];
  md3Weeks: number[];
  rotationId?: string;
  reviewIntent?: ReviewIntent;
  note?: string;
  sources: string[];
}

export interface ResolveUpcomingOptions {
  /** `HH:MM` — drop timed events at/before this clock on `date`. */
  afterTime?: string;
  /** Number of days of recurring duties and harvested one-shots to derive. */
  horizonDays?: number;
  /** Include action-required watchlist rows. Defaults to true. */
  includeActions?: boolean;
}

export interface WbaView extends Wba {
  urgency: WbaUrgency;
  daysUntilDue: number;
}

export interface DayView {
  date: string;
  phase: BlockPhase;
  daysUntilStart: number;
  daysUntilExam: number;
  isOrientation: boolean;
  week: BriefWeek | null;
  attachment: Attachment | null;
  canvasTopics: string[];
  md3Weeks: number[];
  reviewTopics: string[];
  upcomingWbas: WbaView[];
  upcomingDeadlines: Deadline[];
  openWatchlist: WatchItem[];
}

export interface ResolveOptions {
  /** Sort `action-required` watchlist entries above `pending` ones. */
  prioritiseActions?: boolean;
  /** Days ahead of a WBA due date at which it becomes `due-soon`. */
  dueSoonWindowDays?: number;
}

const MS_PER_DAY = 86_400_000;
const DEFAULT_DUE_SOON_WINDOW = 7;

function toUtcDay(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`personal-brief: invalid date "${iso}"`);
  return ms;
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDay(to) - toUtcDay(from)) / MS_PER_DAY);
}

function withinInclusive(date: string, start: string, end: string): boolean {
  const d = toUtcDay(date);
  return d >= toUtcDay(start) && d <= toUtcDay(end);
}

export function weekForDate(brief: CourseBrief, date: string): BriefWeek | null {
  return brief.weeks.find((w) => withinInclusive(date, w.startDate, w.endDate)) ?? null;
}

export function attachmentForDate(brief: CourseBrief, date: string): Attachment | null {
  return brief.attachments.find((a) => withinInclusive(date, a.startDate, a.endDate)) ?? null;
}

export function wbaUrgency(
  wba: Wba,
  date: string,
  dueSoonWindowDays: number = DEFAULT_DUE_SOON_WINDOW,
): WbaUrgency {
  if (wba.status === 'done' || wba.status === 'submitted') return 'done';
  const delta = daysBetween(date, wba.dueDate);
  if (delta < 0) return 'overdue';
  if (delta <= dueSoonWindowDays) return 'due-soon';
  return 'upcoming';
}

function phaseFor(brief: CourseBrief, date: string): BlockPhase {
  if (daysBetween(date, brief.block.startDate) > 0) return 'before';
  if (daysBetween(date, brief.block.endDate) < 0) return 'after';
  return 'during';
}

const WATCH_ORDER: Record<WatchStatus, number> = {
  'action-required': 0,
  pending: 1,
  resolved: 2,
};

/**
 * Collapse the whole brief into what matters on one specific day.
 * This is the only function the page needs.
 */
export function resolveDay(
  brief: CourseBrief,
  date: string,
  options: ResolveOptions = {},
): DayView {
  const { prioritiseActions = false, dueSoonWindowDays = DEFAULT_DUE_SOON_WINDOW } = options;

  const week = weekForDate(brief, date);
  const attachment = attachmentForDate(brief, date);

  const upcomingWbas: WbaView[] = brief.wbas
    .map((w) => ({
      ...w,
      urgency: wbaUrgency(w, date, dueSoonWindowDays),
      daysUntilDue: daysBetween(date, w.dueDate),
    }))
    .filter((w) => w.urgency !== 'done')
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.number - b.number);

  // ISO `YYYY-MM-DD` sorts correctly as a string. Do NOT use daysBetween as a
  // comparator here: it returns `to - from`, which sorts descending.
  const upcomingDeadlines = brief.deadlines
    .filter((d) => daysBetween(date, d.dueDate) >= 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const openWatchlist = brief.watchlist
    .filter((w) => w.status !== 'resolved')
    .sort((a, b) =>
      prioritiseActions ? WATCH_ORDER[a.status] - WATCH_ORDER[b.status] : 0,
    );

  return {
    date,
    phase: phaseFor(brief, date),
    daysUntilStart: daysBetween(date, brief.block.startDate),
    daysUntilExam: daysBetween(date, brief.block.examDate),
    isOrientation: date === brief.block.orientationDate,
    week,
    attachment,
    canvasTopics: week?.canvasTopics ?? [],
    md3Weeks: week?.md3Weeks ?? [],
    reviewTopics: attachment?.reviewTopics ?? [],
    upcomingWbas,
    upcomingDeadlines,
    openWatchlist,
  };
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Weekday for a calendar `YYYY-MM-DD` (UTC noon), Sunday = 0. */
function weekdaySun0(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`personal-brief: invalid time "${hhmm}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`personal-brief: invalid time "${hhmm}"`);
  }
  return hour * 60 + minute;
}

function exactMinutes(value: string | undefined): number | null {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  try {
    return minutesOf(value);
  } catch {
    return null;
  }
}

const APPROXIMATE_TIME_ORDER: Record<string, number> = {
  am: 9 * 60,
  'am/pm': 12 * 60,
  pm: 13 * 60,
  varies: 23 * 60 + 59,
};

function eventWhen(date: string, sourceTime: string | undefined): BriefEventWhen {
  if (!sourceTime) return { date };
  if (exactMinutes(sourceTime) !== null) return { date, time: sourceTime };
  return { date, timeLabel: sourceTime };
}

function eventSortMinutes(event: BriefEvent): number {
  if (event.when.time) return exactMinutes(event.when.time) ?? 24 * 60;
  if (event.when.timeLabel) {
    return APPROXIMATE_TIME_ORDER[event.when.timeLabel.trim().toLowerCase()] ?? 24 * 60 - 1;
  }
  return 24 * 60;
}

function datePlusDays(date: string, days: number): string {
  return new Date(toUtcDay(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function firstWeekdayOnOrAfter(startDate: string, targetSun0: number): string {
  const startSun0 = weekdaySun0(startDate);
  const offset = (targetSun0 - startSun0 + 7) % 7;
  return datePlusDays(startDate, offset);
}

function daySpecContainsWeekday(value: string, sun0: number): boolean {
  const short = DOW_SHORT[sun0].toLowerCase();
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    sun0
  ];
  return value.includes(short) || value.includes(full);
}

function anchorAppliesOn(
  daysSpec: string,
  date: string,
  attachment: Attachment,
): boolean {
  const s = daysSpec.trim().toLowerCase();
  const sun0 = weekdaySun0(date);

  if (s.startsWith('first ')) {
    const target = DOW_SHORT.findIndex((day) => s.includes(day.toLowerCase()));
    return target >= 0 && date === firstWeekdayOnOrAfter(attachment.startDate, target);
  }

  if (s.startsWith('daily')) {
    const excluded = s.match(/\bexcept\s+(.+)$/)?.[1];
    return !excluded || !daySpecContainsWeekday(excluded, sun0);
  }
  if (/mon\s*[–\-]\s*fri/.test(s) || s.includes('weekday')) {
    return sun0 >= 1 && sun0 <= 5;
  }
  return daySpecContainsWeekday(s, sun0);
}

function fixtureAppliesOn(dayLabel: string, sun0: number): boolean {
  return dayLabel.trim().slice(0, 3).toLowerCase() === DOW_SHORT[sun0].toLowerCase();
}

function sortTimedThenActions(events: BriefEvent[]): BriefEvent[] {
  const timed = events
    .filter((e) => e.kind !== 'action')
    .sort((a, b) => {
      const byDate = a.when.date.localeCompare(b.when.date);
      if (byDate !== 0) return byDate;
      const at = eventSortMinutes(a);
      const bt = eventSortMinutes(b);
      return at - bt || a.title.localeCompare(b.title);
    });
  const actions = events.filter((e) => e.kind === 'action');
  return [...timed, ...actions];
}

/**
 * Duties and harvested one-shots that occur on exactly one calendar day.
 * Standing WBAs/deadlines/actions are added by the public day/horizon resolvers.
 */
function deriveCalendarEvents(
  brief: CourseBrief,
  date: string,
): BriefEvent[] {
  const sun0 = weekdaySun0(date);
  const attachment = attachmentForDate(brief, date);
  const week = weekForDate(brief, date);
  const rotationId = brief.block.rotationId;
  const md3Weeks = week?.md3Weeks?.length
    ? week.md3Weeks
    : (attachment?.weeks ?? []);
  const prepTopics = attachment?.reviewTopics ?? [];

  const out: BriefEvent[] = [];

  if (attachment) {
    for (const anchor of attachment.dailyAnchors ?? []) {
      if (!anchorAppliesOn(anchor.days, date, attachment)) continue;
      const exactStart = exactMinutes(anchor.time) !== null ? anchor.time : undefined;
      out.push({
        id: `duty-anchor-${date}-${attachment.label}-${anchor.time}-${anchor.what}`,
        kind: 'duty',
        title: anchor.what,
        when: eventWhen(date, anchor.time),
        where: anchor.where,
        leaveBy: brief.commute && exactStart
          ? leaveByOptions(
              { ...attachment, firstDayStart: exactStart },
              brief.commute,
            )[0]?.leaveBy
          : undefined,
        prepTopics,
        md3Weeks,
        rotationId,
        reviewIntent: {
          rotation: rotationId,
          ...(md3Weeks[0] !== undefined ? { week: md3Weeks[0] } : {}),
        },
        sources: attachment.source ? [attachment.source] : [],
      });
    }
    for (const fix of attachment.weeklyFixtures ?? []) {
      if (!fixtureAppliesOn(fix.day, sun0)) continue;
      out.push({
        id: `duty-fix-${date}-${attachment.label}-${fix.day}-${fix.time}-${fix.what}`,
        kind: 'duty',
        title: fix.what,
        when: eventWhen(date, fix.time),
        where: fix.where,
        prepTopics,
        md3Weeks,
        rotationId,
        reviewIntent: {
          rotation: rotationId,
          ...(md3Weeks[0] !== undefined ? { week: md3Weeks[0] } : {}),
        },
        sources: attachment.source ? [attachment.source] : [],
      });
    }
  }

  for (const e of brief.events ?? []) {
    if (e.date !== date) continue;
    const eventAttachment = attachmentForDate(brief, e.date);
    const eventWeek = weekForDate(brief, e.date);
    const eventMd3Weeks = e.md3Weeks
      ?? (eventWeek?.md3Weeks?.length ? eventWeek.md3Weeks : (eventAttachment?.weeks ?? []));
    out.push({
      id: e.id,
      kind: e.kind ?? 'harvested',
      title: e.title,
      when: eventWhen(e.date, e.time),
      where: e.where,
      prepTopics: e.prepTopics ?? [],
      md3Weeks: eventMd3Weeks,
      rotationId: e.reviewIntent?.rotation,
      reviewIntent: e.reviewIntent,
      note: e.note,
      sources: e.sources ?? [],
    });
  }

  return sortTimedThenActions(out);
}

function reviewIntentForWba(brief: CourseBrief, wba: Wba): ReviewIntent | undefined {
  if (wba.reviewIntent) return wba.reviewIntent;
  const dueWeek = brief.weeks.find((week) => week.week === wba.dueWeek);
  return {
    rotation: brief.block.rotationId,
    ...(dueWeek?.md3Weeks[0] !== undefined ? { week: dueWeek.md3Weeks[0] } : {}),
  };
}

function wbaEvent(brief: CourseBrief, w: Wba): BriefEvent {
  const intent = reviewIntentForWba(brief, w);
  const dueWeek = brief.weeks.find((week) => week.week === w.dueWeek);
  return {
    id: `wba-${w.id}`,
    kind: 'wba',
    title: `WBA ${w.number} · ${w.title}`,
    when: eventWhen(w.dueDate, w.dueTime || undefined),
    prepTopics: w.prepTopics,
    md3Weeks: dueWeek?.md3Weeks ?? [],
    rotationId: intent?.rotation,
    reviewIntent: intent,
    note: w.note,
    sources: w.dueSource ? [w.dueSource] : [],
  };
}

function deadlineEvent(brief: CourseBrief, d: Deadline): BriefEvent {
  return {
    id: `deadline-${d.title}-${d.dueDate}`,
    kind: 'deadline',
    title: d.title,
    when: { date: d.dueDate },
    where: d.where,
    prepTopics: [],
    md3Weeks: [],
    rotationId: d.reviewIntent?.rotation,
    reviewIntent: d.reviewIntent,
    sources: [d.kind],
  };
}

function actionEvents(brief: CourseBrief, date: string): BriefEvent[] {
  return brief.watchlist
    .filter((w) => w.status === 'action-required')
    .map((w) => ({
      id: `action-${w.item}`,
      kind: 'action' as const,
      title: w.item,
      when: { date },
      prepTopics: [],
      md3Weeks: [],
      note: w.note,
      sources: [w.source],
    }));
}

function filterAfterTime(
  events: BriefEvent[],
  date: string,
  afterTime: string | undefined,
): BriefEvent[] {
  if (afterTime === undefined) return events;
  const afterMins = minutesOf(afterTime);
  return events.filter((event) => {
    if (event.kind === 'action' || event.when.date !== date || !event.when.time) return true;
    const eventMinutes = exactMinutes(event.when.time);
    return eventMinutes === null || eventMinutes > afterMins;
  });
}

/**
 * Exact-day timeline. Unlike `resolveUpcomingEvents`, this never mixes future
 * deadlines into a card labelled "Today".
 */
export function resolveDayEvents(
  brief: CourseBrief,
  date: string,
  options: ResolveUpcomingOptions = {},
): BriefEvent[] {
  const { afterTime, includeActions = true } = options;
  const out = deriveCalendarEvents(brief, date);

  for (const w of brief.wbas) {
    if (w.status === 'done' || w.status === 'submitted') continue;
    if (w.dueDate === date) out.push(wbaEvent(brief, w));
  }

  for (const d of brief.deadlines) {
    if (d.dueDate === date) out.push(deadlineEvent(brief, d));
  }

  if (includeActions) out.push(...actionEvents(brief, date));
  return filterAfterTime(sortTimedThenActions(out), date, afterTime);
}

/**
 * Chronological upcoming horizon. Recurring duties and harvested one-shots are
 * bounded; standing deadlines remain visible, and unfinished overdue WBAs stay
 * visible until their source status changes.
 */
export function resolveUpcomingEvents(
  brief: CourseBrief,
  date: string,
  options: ResolveUpcomingOptions = {},
): BriefEvent[] {
  const {
    afterTime,
    horizonDays = 30,
    includeActions = true,
  } = options;
  const boundedHorizon = Math.min(Math.max(Math.floor(horizonDays), 0), 366);
  const out: BriefEvent[] = [];

  for (let offset = 0; offset <= boundedHorizon; offset += 1) {
    out.push(...deriveCalendarEvents(brief, datePlusDays(date, offset)));
  }

  for (const w of brief.wbas) {
    if (w.status === 'done' || w.status === 'submitted') continue;
    out.push(wbaEvent(brief, w));
  }

  for (const d of brief.deadlines) {
    if (daysBetween(date, d.dueDate) >= 0) out.push(deadlineEvent(brief, d));
  }

  if (includeActions) out.push(...actionEvents(brief, date));
  return filterAfterTime(sortTimedThenActions(out), date, afterTime);
}

/**
 * Roll `HH:MM` back by N minutes, wrapping across midnight.
 * Returns `{ time, previousDay }` so a 07:00 start minus a 75-minute commute
 * reads as 05:45 today, not a silently-wrong 23:45.
 */
export function minusMinutes(
  hhmm: string,
  minutes: number,
): { time: string; previousDay: boolean } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`personal-brief: invalid time "${hhmm}"`);
  const total = Number(m[1]) * 60 + Number(m[2]) - minutes;
  const previousDay = total < 0;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return { time: `${hh}:${mm}`, previousDay };
}

/**
 * When to leave home for each commute option, given the attachment's start
 * time. Uses the pessimistic end of `minutesRealistic` where one is recorded —
 * a leave-by time built on an optimistic estimate is worse than none.
 */
export function leaveByOptions(
  attachment: Attachment | null,
  commute: Commute | undefined,
  bufferMinutes = 10,
): Array<{ mode: string; leaveBy: string; basisMinutes: number; optimistic: boolean }> {
  if (!attachment?.firstDayStart || !commute) return [];
  return commute.options.map((o) => {
    const worst = o.minutesRealistic
      ? Math.max(...o.minutesRealistic.split(/[^\d]+/).filter(Boolean).map(Number))
      : o.minutes;
    const basisMinutes = worst + bufferMinutes;
    return {
      mode: o.mode,
      leaveBy: minusMinutes(attachment.firstDayStart!, basisMinutes).time,
      basisMinutes,
      optimistic: !o.minutesRealistic,
    };
  });
}

/** Today's date in Sydney, as `YYYY-MM-DD`. */
export function sydneyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Current Sydney clock as `HH:MM` (24h). */
export function sydneyNowTime(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}
