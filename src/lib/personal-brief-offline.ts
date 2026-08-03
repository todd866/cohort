import type {
  Attachment,
  BriefWeek,
  CommuteOption,
  CourseBrief,
  Deadline,
  HarvestedBriefEvent,
  WatchItem,
  Wba,
} from './personal-brief';

export const OFFLINE_BRIEF_SCHEMA_VERSION = 1;

type OfflineBlock = Pick<
  CourseBrief['block'],
  | 'rotationId'
  | 'name'
  | 'term'
  | 'startDate'
  | 'endDate'
  | 'orientationDate'
  | 'examDate'
  | 'examLabel'
> & {
  siteName: string;
  siteShortName: string;
};

type OfflineAttachment = Pick<
  Attachment,
  | 'label'
  | 'startDate'
  | 'endDate'
  | 'weeks'
  | 'reviewTopics'
  | 'location'
  | 'firstDayStart'
  | 'dailyAnchors'
  | 'weeklyFixtures'
>;

type OfflineWatchItem = Pick<WatchItem, 'item' | 'status' | 'expectedBy' | 'note'>;
type OfflineCommuteOption = Pick<CommuteOption, 'mode' | 'minutes' | 'minutesRealistic'>;

/**
 * Purpose-limited snapshot for localStorage. It contains enough to answer
 * "where/when/what should I prepare?" while excluding identity, contacts,
 * source URLs, home address, routes, cost model, and the wider dossier.
 */
export interface OfflineBriefSnapshot {
  schemaVersion: number;
  updatedAt: string;
  block: OfflineBlock;
  attachments: OfflineAttachment[];
  weeks: BriefWeek[];
  wbas: Wba[];
  deadlines: Deadline[];
  watchlist: OfflineWatchItem[];
  events: HarvestedBriefEvent[];
  commuteOptions: OfflineCommuteOption[];
}

export function isOfflineBriefSnapshot(value: unknown): value is OfflineBriefSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OfflineBriefSnapshot>;
  return (
    candidate.schemaVersion === OFFLINE_BRIEF_SCHEMA_VERSION
    && !!candidate.block
    && typeof candidate.block === 'object'
    && Array.isArray(candidate.attachments)
    && Array.isArray(candidate.weeks)
    && Array.isArray(candidate.wbas)
    && Array.isArray(candidate.deadlines)
    && Array.isArray(candidate.watchlist)
    && Array.isArray(candidate.events)
    && Array.isArray(candidate.commuteOptions)
  );
}

function offlineText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact removed]')
    .replace(/https?:\/\/\S+/gi, '[link removed]');
}

export function createOfflineBriefSnapshot(brief: CourseBrief): OfflineBriefSnapshot {
  return {
    schemaVersion: OFFLINE_BRIEF_SCHEMA_VERSION,
    updatedAt: brief.updatedAt,
    block: {
      rotationId: brief.block.rotationId,
      name: brief.block.name,
      term: brief.block.term,
      startDate: brief.block.startDate,
      endDate: brief.block.endDate,
      orientationDate: brief.block.orientationDate,
      examDate: brief.block.examDate,
      examLabel: brief.block.examLabel,
      siteName: brief.block.site.name,
      siteShortName: brief.block.site.shortName,
    },
    attachments: brief.attachments.map((attachment) => ({
      label: attachment.label,
      startDate: attachment.startDate,
      endDate: attachment.endDate,
      weeks: [...attachment.weeks],
      reviewTopics: [...attachment.reviewTopics],
      ...(attachment.location ? { location: attachment.location } : {}),
      ...(attachment.firstDayStart ? { firstDayStart: attachment.firstDayStart } : {}),
      ...(attachment.dailyAnchors
        ? { dailyAnchors: attachment.dailyAnchors.map((anchor) => ({ ...anchor })) }
        : {}),
      ...(attachment.weeklyFixtures
        ? { weeklyFixtures: attachment.weeklyFixtures.map((fixture) => ({ ...fixture })) }
        : {}),
    })),
    weeks: brief.weeks.map((week) => ({
      ...week,
      canvasTopics: [...week.canvasTopics],
      md3Weeks: [...week.md3Weeks],
      note: offlineText(week.note),
    })),
    wbas: brief.wbas.map((wba) => ({
      ...wba,
      prepTopics: [...wba.prepTopics],
      // Source URLs and dispute documents belong in the online dossier.
      prepResources: [],
      dueConflict: undefined,
      note: offlineText(wba.note),
    })),
    deadlines: brief.deadlines.map((deadline) => ({
      ...deadline,
      where: offlineText(deadline.where) ?? '',
    })),
    watchlist: brief.watchlist.map(({ item, status, expectedBy, note }) => ({
      item,
      status,
      ...(expectedBy ? { expectedBy } : {}),
      ...(note ? { note: offlineText(note) } : {}),
    })),
    events: (brief.events ?? []).map((event) => ({
      ...event,
      sources: undefined,
      prepTopics: event.prepTopics ? [...event.prepTopics] : undefined,
      md3Weeks: event.md3Weeks ? [...event.md3Weeks] : undefined,
      reviewIntent: event.reviewIntent ? { ...event.reviewIntent } : undefined,
      where: offlineText(event.where),
      note: offlineText(event.note),
    })),
    commuteOptions: (brief.commute?.options ?? []).map(({ mode, minutes, minutesRealistic }) => ({
      mode,
      minutes,
      ...(minutesRealistic ? { minutesRealistic } : {}),
    })),
  };
}

/**
 * Rehydrate only the shape needed by the pure schedule resolver. Placeholder
 * fields are never rendered by the compact offline view.
 */
export function courseBriefFromOfflineSnapshot(snapshot: OfflineBriefSnapshot): CourseBrief {
  return {
    schemaVersion: 1,
    ownerUserId: '',
    updatedAt: snapshot.updatedAt,
    sources: [],
    block: {
      id: snapshot.block.rotationId,
      rotationId: snapshot.block.rotationId,
      name: snapshot.block.name,
      term: snapshot.block.term,
      startDate: snapshot.block.startDate,
      endDate: snapshot.block.endDate,
      orientationDate: snapshot.block.orientationDate,
      examDate: snapshot.block.examDate,
      examLabel: snapshot.block.examLabel,
      homeClinicalSchool: '',
      site: {
        name: snapshot.block.siteName,
        shortName: snapshot.block.siteShortName,
        note: '',
        wayfindingPages: [],
      },
      contacts: [],
    },
    commute: snapshot.commuteOptions.length > 0
      ? {
          origin: '',
          destination: snapshot.block.siteName,
          options: snapshot.commuteOptions.map((option) => ({
            ...option,
            route: '',
            caveats: [],
            verified: '',
          })),
        }
      : undefined,
    attachments: snapshot.attachments.map((attachment) => ({ ...attachment })),
    weeks: snapshot.weeks.map((week) => ({ ...week })),
    wbas: snapshot.wbas.map((wba) => ({ ...wba, prepResources: [] })),
    preArrival: [],
    deadlines: snapshot.deadlines.map((deadline) => ({ ...deadline })),
    arrivalFacts: [],
    watchlist: snapshot.watchlist.map((item) => ({
      ...item,
      source: 'offline-snapshot',
    })),
    events: snapshot.events.map((event) => ({ ...event, sources: [] })),
  };
}
