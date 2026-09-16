/**
 * Where, inside a forty-minute operation, are the eight seconds worth asking a
 * question about?
 *
 * Three independent signals, none of which costs anything beyond the single
 * metadata call that already precedes a download:
 *
 *  - **The most-replayed heatmap.** `yt-dlp -J` returns 100 buckets of
 *    `{start_time, end_time, value}` — YouTube's own record of where viewers
 *    scrub back to. On an operative video that is very close to a definition of
 *    "the teachable manoeuvre": nobody rewinds the draping.
 *  - **Chapter marks.** Where an uploader has chaptered the video, they have
 *    already done the segmentation by hand, and the title names the step.
 *  - **Narration.** A surgeon saying "now we open the dura" timestamps the step
 *    to the second.
 *
 * Each generator emits a candidate window; overlapping candidates merge and
 * their scores add, so a moment all three signals agree on outranks a moment
 * only one of them found. The output is a ranked shortlist for the vision vet,
 * never a finished clip — roughly the same division of labour as
 * `discover-prompt-candidates` in the image-as-prompt pipeline, where cheap
 * signals propose and an expensive check disposes.
 */

export interface HeatmapBucket {
  start_time: number;
  end_time: number;
  value: number;
}

export interface Chapter {
  start_time: number;
  end_time?: number;
  title?: string;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

export interface ClipWindowInput {
  durationSecs: number;
  chapters?: Chapter[] | null;
  heatmap?: HeatmapBucket[] | null;
  transcriptCues?: TranscriptCue[] | null;
  /** Dead zone at the head of the video — titles, patient consent, draping.
   *  Overridable because a two-minute technique demo has no such preamble. */
  introSecs?: number;
  /** Dead zone at the tail — closing, credits, "like and subscribe". */
  outroSecs?: number;
}

export interface ClipWindowOptions {
  minSecs?: number;
  maxSecs?: number;
  /** Preferred length when a generator anchors on an instant rather than a span. */
  targetSecs?: number;
  maxWindows?: number;
  /**
   * Spread windows evenly even on a long source with no signal.
   *
   * The duration cap on the automatic fallback protects against carpeting an
   * unvetted forty-minute video. It is the wrong default once a human has
   * LOOKED at the source and confirmed it is operative throughout — which is
   * the common case for the best material, because surgeon-uploaded operative
   * video is typically silent, unchaptered and too niche for a heatmap. Set
   * this only for a source you have actually watched.
   */
  forceDense?: boolean;
}

export interface ClipWindow {
  startSecs: number;
  endSecs: number;
  score: number;
  /** Which generators contributed. Carried through to the candidate file so a
   *  human reviewing a rejected clip can see why it was ever proposed. */
  signals: Array<'heatmap' | 'chapter' | 'transcript' | 'dense'>;
  /** Chapter title or narration line that anchored the window, for the authoring
   *  step's draft question. Never shown to a learner pre-reveal. */
  hint?: string;
}

const DEFAULTS = {
  minSecs: 6,
  maxSecs: 10,
  targetSecs: 8,
  maxWindows: 12,
  forceDense: false,
} as const;

/**
 * Dead zones at the head and tail, in seconds, scaled to the source.
 *
 * A forty-minute operation opens with titles, consent and draping, and closes
 * with skin and credits; thirty seconds each end is cheap insurance. A
 * two-minute technique demo has none of that, and the same flat thirty seconds
 * removes 40% of it — measured 2026-09-11, when a 153s and a 139s operative
 * clip both returned zero candidates for exactly this reason. So the zone is a
 * fraction of the runtime, capped at the value that suits a long one.
 */
const DEAD_ZONE_FRACTION = 0.08;
const MAX_DEAD_ZONE_SECS = 30;

function deadZoneSecs(durationSecs: number): number {
  return Math.min(MAX_DEAD_ZONE_SECS, durationSecs * DEAD_ZONE_FRACTION);
}

/** Chapter titles that mark packaging rather than operating. */
const NON_OPERATIVE_TITLE = /\b(intro|introduction|outro|subscribe|credits?|disclaimer|thanks|sponsor|conclusion|summary|recap|q\s*&\s*a|questions)\b/i;

/**
 * A chapter titled as a question is a lecture segment — "What are the
 * developmental origins?", "How do you decide on repair?" — and the camera is
 * on a person, not a field. Cheap to reject here; a vision-vet call to discover
 * the same thing is not.
 */
const LECTURE_QUESTION_TITLE = /(\?\s*$)|^\s*(what|why|how|when|who|which|do|does|can|should|is|are)\b/i;

/**
 * Narration that announces a step about to happen or a structure about to be
 * shown. Deliberately narrow: a loose pattern matches every other sentence a
 * talkative surgeon says, and the cost of a false positive is a vision-vet call
 * we paid for and threw away.
 */
const STEP_NARRATION: RegExp[] = [
  /\bnow (?:we|i|you)\b/i,
  /\bnext (?:we|i|step)\b/i,
  /\bthe next step\b/i,
  /\bwe(?:'re| are) (?:going to|about to)\b/i,
  /\b(?:i'm|i am) (?:going to|about to)\b/i,
  /\bhere (?:we|you) (?:can )?see\b/i,
  /\b(?:identify|notice|look at) the\b/i,
];

/** Score weights. Heatmap scales with peak height; the other two are flat
 *  because a chapter mark is a chapter mark. */
const CHAPTER_WEIGHT = 0.8;
const TRANSCRIPT_WEIGHT = 0.7;

/**
 * A short source with no heatmap, no chapters and no step narration is not a
 * source with nothing in it — measured 2026-09-11, both such cases were 2.5
 * minutes of wall-to-wall operating. "Where is the interesting part" is the
 * wrong question there, because all of it is, so spread windows evenly and let
 * the vision vet choose. Deliberately capped: doing this to a forty-minute
 * operation would buy forty vet calls to rediscover the draping.
 */
const DENSE_FALLBACK_MAX_DURATION_SECS = 300;
/** Below every real signal, so a dense window never outranks a found one. */
const DENSE_WEIGHT = 0.1;

function denseCandidates(
  input: ClipWindowInput,
  opts: Required<ClipWindowOptions>,
  introSecs: number,
  outroSecs: number,
): Candidate[] {
  const liveStart = introSecs;
  const liveEnd = input.durationSecs - outroSecs;
  const liveLength = liveEnd - liveStart;
  if (liveLength < opts.targetSecs) return [];

  const count = Math.min(opts.maxWindows, Math.floor(liveLength / opts.targetSecs));
  if (count < 1) return [];

  const spacing = liveLength / count;
  return Array.from({ length: count }, (_, i) => {
    const start = liveStart + i * spacing;
    return {
      startSecs: round(start),
      endSecs: round(start + opts.targetSecs),
      score: DENSE_WEIGHT,
      signals: ['dense' as const],
    };
  });
}

/** A bucket counts as a peak once it clears half the distance from the typical
 *  bucket to the tallest one. Relative, because heatmap values are normalised
 *  per video and an absolute cut would be meaningless across sources. */
const PEAK_RELIEF_FRACTION = 0.5;
/** Below this much spread the graph is flat and there is no "most replayed"
 *  moment to find — every bucket would otherwise clear a threshold that has
 *  collapsed onto the baseline. */
const MIN_MEANINGFUL_RELIEF = 0.15;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Coerce a rough span into a legal window that still lies inside the video.
 * Short spans grow around their centre; long ones shrink to `targetSecs` around
 * their centre; anything hanging off an end slides back inside rather than
 * being truncated, so the window keeps its full length.
 */
function fitWindow(
  start: number,
  end: number,
  duration: number,
  opts: Required<ClipWindowOptions>,
): { startSecs: number; endSecs: number } {
  let s = start;
  let e = end;
  const len = e - s;

  if (len < opts.minSecs || len > opts.maxSecs) {
    const want = len > opts.maxSecs ? opts.targetSecs : opts.minSecs;
    const centre = (s + e) / 2;
    s = centre - want / 2;
    e = centre + want / 2;
  }

  // The video may be shorter than the window we want; clamping start first and
  // end second would silently return a sub-minimum window, so take the whole
  // video in that case and let the caller's bounds check speak.
  if (e - s > duration) return { startSecs: 0, endSecs: duration };
  if (s < 0) { e -= s; s = 0; }
  if (e > duration) { s -= e - duration; e = duration; }
  return { startSecs: round(s), endSecs: round(e) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

type Candidate = ClipWindow;

function heatmapCandidates(
  input: ClipWindowInput,
  opts: Required<ClipWindowOptions>,
): Candidate[] {
  const buckets = (input.heatmap ?? []).filter((b) => Number.isFinite(b.value));
  if (buckets.length < 3) return [];

  const values = buckets.map((b) => b.value);
  const baseline = median(values);
  const peak = Math.max(...values);
  const relief = peak - baseline;
  if (relief < MIN_MEANINGFUL_RELIEF) return [];

  const threshold = baseline + relief * PEAK_RELIEF_FRACTION;
  return buckets
    .filter((b) => b.value >= threshold)
    .map((b) => {
      const { startSecs, endSecs } = fitWindow(b.start_time, b.end_time, input.durationSecs, opts);
      return {
        startSecs,
        endSecs,
        // Normalised height above the baseline, so a video with one towering
        // peak and one with several modest ones score comparably.
        score: relief > 0 ? (b.value - baseline) / relief : 0,
        signals: ['heatmap' as const],
      };
    });
}

function chapterCandidates(
  input: ClipWindowInput,
  opts: Required<ClipWindowOptions>,
): Candidate[] {
  return (input.chapters ?? [])
    .filter((c) => Number.isFinite(c.start_time))
    .filter((c) => !NON_OPERATIVE_TITLE.test(c.title ?? ''))
    .filter((c) => !LECTURE_QUESTION_TITLE.test(c.title ?? ''))
    .map((c) => {
      // A chapter mark is where a step BEGINS. Centring the window on it would
      // spend half the clip on the step that just finished.
      const { startSecs, endSecs } = fitWindow(
        c.start_time,
        c.start_time + opts.targetSecs,
        input.durationSecs,
        opts,
      );
      return {
        startSecs,
        endSecs,
        score: CHAPTER_WEIGHT,
        signals: ['chapter' as const],
        hint: c.title,
      };
    });
}

function transcriptCandidates(
  input: ClipWindowInput,
  opts: Required<ClipWindowOptions>,
): Candidate[] {
  return (input.transcriptCues ?? [])
    .filter((cue) => STEP_NARRATION.some((re) => re.test(cue.text)))
    .map((cue) => {
      const { startSecs, endSecs } = fitWindow(
        cue.start,
        cue.start + opts.targetSecs,
        input.durationSecs,
        opts,
      );
      return {
        startSecs,
        endSecs,
        score: TRANSCRIPT_WEIGHT,
        signals: ['transcript' as const],
        hint: cue.text,
      };
    });
}

/**
 * Merge overlapping candidates. The highest-scoring member keeps its window —
 * a heatmap peak localises the moment better than a chapter mark does — and
 * absorbs the others' signals and scores.
 */
function mergeOverlapping(candidates: Candidate[]): Candidate[] {
  const byStart = [...candidates].sort((a, b) => a.startSecs - b.startSecs);
  const merged: Candidate[] = [];

  for (const cand of byStart) {
    const last = merged[merged.length - 1];
    if (last && cand.startSecs < last.endSecs) {
      const signals = Array.from(new Set([...last.signals, ...cand.signals]));
      const keep = cand.score > last.score ? cand : last;
      merged[merged.length - 1] = {
        startSecs: keep.startSecs,
        endSecs: keep.endSecs,
        score: last.score + cand.score,
        signals,
        hint: last.hint ?? cand.hint,
      };
    } else {
      merged.push({ ...cand, signals: [...cand.signals] });
    }
  }
  return merged;
}

export function selectClipWindows(
  input: ClipWindowInput,
  options: ClipWindowOptions = {},
): ClipWindow[] {
  const opts: Required<ClipWindowOptions> = { ...DEFAULTS, ...options };
  const introSecs = input.introSecs ?? deadZoneSecs(input.durationSecs);
  const outroSecs = input.outroSecs ?? deadZoneSecs(input.durationSecs);

  const all = [
    ...heatmapCandidates(input, opts),
    ...chapterCandidates(input, opts),
    ...transcriptCandidates(input, opts),
  ];

  const live = all.filter(
    (c) => c.startSecs >= introSecs && c.endSecs <= input.durationSecs - outroSecs,
  );

  // The fallback runs only when nothing real fired. A source with one good
  // heatmap peak is better served by that peak alone than by it plus eleven
  // arbitrary neighbours.
  if (live.length === 0
    && (opts.forceDense || input.durationSecs <= DENSE_FALLBACK_MAX_DURATION_SECS)) {
    return denseCandidates(input, opts, introSecs, outroSecs);
  }

  return mergeOverlapping(live)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxWindows);
}
