/**
 * Which exam blueprint area an answered item, a practice-paper score or a
 * recorded exam score belongs to, per rotation.
 *
 * Areas are keyed by a canonical ID from the rotation's taxonomy
 * (./blueprint-areas-data); the label is display text owned by code. A
 * learner may also record a custom area, keyed `custom:<label>` with a
 * strictly validated label (./exam-result.ts). Custom labels are learner text:
 * they are shown to the learner, quoted as untrusted data to the tutor, and
 * never written to a committed audit artefact.
 *
 * A rotation without a registered blueprint (the public build) keys each item
 * by its own domain label; an item with no domain falls in UNASSIGNED_AREA so
 * totals still add up.
 */
import { STATS_BLUEPRINTS } from './blueprint-areas-data';
import { CUSTOM_AREA_LABEL, CUSTOM_AREA_PREFIX, customAreaKey, isCustomArea, isValidCustomKey } from './area-keys';

export interface StatsBlueprintArea { id: string; label: string }
export interface StatsBlueprint {
  /** The areas the official feedback reports, in blueprint order. */
  areas: StatsBlueprintArea[];
  /** examDomain (or practice-scorer domain) label → area ID. */
  areaForDomain: Record<string, string>;
}

export const UNASSIGNED_AREA = 'unassigned';
const UNASSIGNED_LABEL = 'Unassigned';
export { CUSTOM_AREA_PREFIX, customAreaKey, isCustomArea };

type Blueprints = Readonly<Record<string, StatsBlueprint>>;

export function blueprintFor(rotation: string, blueprints: Blueprints = STATS_BLUEPRINTS): StatsBlueprint | null {
  return Object.hasOwn(blueprints, rotation) ? blueprints[rotation] : null;
}

/**
 * A stored exam-area key, resolved against its rotation's taxonomy. Canonical
 * status comes from membership only: a verified ID stays; a recognised
 * legacy label becomes its ID; a valid `custom:` key stays custom; any other
 * single-line label becomes custom (untrusted learner text); the rest is dropped.
 */
export function resolveStoredArea(rotation: string, key: string, blueprints: Blueprints = STATS_BLUEPRINTS): string | null {
  if (isCustomArea(key)) return isValidCustomKey(key) ? key : null;
  const areas = blueprintFor(rotation, blueprints)?.areas ?? [];
  const byId = areas.find((a) => a.id === key);
  if (byId) return byId.id;
  const byLabel = areas.find((a) => a.label === key);
  if (byLabel) return byLabel.id;
  // Older recorders typed the label by hand: match it in any case, and in
  // the feedback's own abbreviations, before treating it as custom text.
  // Domains are NOT rolled up here: two domains under one area would collide
  // in readAreas and drop one score.
  const matched = matchAreaLabel(rotation, key, blueprints);
  if (matched) return matched;
  return CUSTOM_AREA_LABEL.test(key) ? customAreaKey(key) : null;
}

/** Words that never distinguish one area from another. */
const FILLER = new Set(['and', 'of', 'for', 'the', 'in', 'incl', 'including', 'other', 'care', 'common', 'conditions', 'based', 'clinical', 'system']);

function normaliseLabel(label: string): string {
  return label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Significant words, singular, so "Sub-specialties" and "sub specialty" agree. */
function labelWords(label: string): Set<string> {
  return new Set(normaliseLabel(label).split(' ')
    .filter((w) => w && !FILLER.has(w))
    .map((w) => w.replace(/ies$/, 'y').replace(/(?<=[a-z]{3})s$/, '')));
}

/**
 * A canonical area for a label as the official feedback (or a person) writes
 * it, or null. Case, punctuation and footnote marks are ignored; then one
 * label's significant words must be a subset of exactly one area's, so the
 * feedback's abbreviations ("Drugs/Pain Management", "Pre/Post op and
 * Anaesthesia", "Community paediatrics") resolve while a bare "Paediatrics",
 * which fits several areas, does not.
 */
export function matchAreaLabel(rotation: string, label: string, blueprints: Blueprints = STATS_BLUEPRINTS): string | null {
  const areas = blueprintFor(rotation, blueprints)?.areas ?? [];
  if (!label.trim() || label.length > 200) return null;
  const exact = areas.find((a) => a.id === label || a.label === label);
  if (exact) return exact.id;
  const norm = normaliseLabel(label);
  const folded = areas.filter((a) => normaliseLabel(a.label) === norm);
  if (folded.length === 1) return folded[0].id;
  const words = labelWords(label);
  if (words.size === 0) return null;
  const fits = areas.filter((a) => {
    const target = labelWords(a.label);
    const [small, large] = words.size <= target.size ? [words, target] : [target, words];
    return small.size > 0 && [...small].every((w) => large.has(w));
  });
  return fits.length === 1 ? fits[0].id : null;
}

/**
 * Practice-paper and legacy examDomain strings that name the same blueprint
 * area as the official label. Keys are `normaliseLabel` output.
 */
const DOMAIN_ALIASES: Record<string, Record<string, string>> = {
  'critical-care': {
    'gastrointestinal and surgery': 'cc.gi-surgery',
    'preoperative postoperative care and anaesthesia': 'cc.perioperative-anaesthesia',
    'perioperative and anaesthesia': 'cc.perioperative-anaesthesia',
    'drugs for common conditions and pain': 'cc.drugs-pain',
    'trauma and orthopaedics': 'cc.trauma-orthopaedics',
    'vertical themes': 'cc.vertical-theme-other',
    'vertical theme other': 'cc.vertical-theme-other',
  },
};

/** Area ID for an item's exam domain. */
export function areaForItem(rotation: string, examDomain: string | null, blueprints: Blueprints = STATS_BLUEPRINTS): string {
  if (!examDomain) return UNASSIGNED_AREA;
  const blueprint = blueprintFor(rotation, blueprints);
  if (!blueprint) return examDomain;
  if (Object.hasOwn(blueprint.areaForDomain, examDomain)) return blueprint.areaForDomain[examDomain];
  const key = normaliseLabel(examDomain);
  const folded = Object.entries(blueprint.areaForDomain).find(([label]) => normaliseLabel(label) === key);
  if (folded) return folded[1];
  return DOMAIN_ALIASES[rotation]?.[key] ?? examDomain;
}

/**
 * Area ID for a code-owned label: a practice paper's byArea key (an official
 * area label for CAH, a leaf domain such as "Tobacco" for PAAM) or a legacy
 * stored label. Matches an area label first, then rolls a domain up.
 */
export function areaForLabel(rotation: string, label: string, blueprints: Blueprints = STATS_BLUEPRINTS): string {
  const blueprint = blueprintFor(rotation, blueprints);
  const byLabel = blueprint?.areas.find((a) => a.label === label || a.id === label);
  if (byLabel) return byLabel.id;
  if (blueprint && Object.hasOwn(blueprint.areaForDomain, label)) return blueprint.areaForDomain[label];
  return matchAreaLabel(rotation, label, blueprints) ?? areaForItem(rotation, label, blueprints);
}

export function areaLabel(rotation: string, key: string, blueprints: Blueprints = STATS_BLUEPRINTS): string {
  if (key === UNASSIGNED_AREA) return UNASSIGNED_LABEL;
  if (isCustomArea(key)) return key.slice(CUSTOM_AREA_PREFIX.length);
  return blueprintFor(rotation, blueprints)?.areas.find((a) => a.id === key)?.label ?? key;
}

/** Areas to offer on the exam-result form: the blueprint's, or none. */
export function formAreas(rotation: string, blueprints: Blueprints = STATS_BLUEPRINTS): StatsBlueprintArea[] {
  return blueprintFor(rotation, blueprints)?.areas ?? [];
}

/** Area IDs in blueprint order, for table ordering. */
export function blueprintAreaIds(rotation: string, blueprints: Blueprints = STATS_BLUEPRINTS): string[] {
  return formAreas(rotation, blueprints).map((a) => a.id);
}

export function isCanonicalArea(rotation: string, id: string, blueprints: Blueprints = STATS_BLUEPRINTS): boolean {
  return formAreas(rotation, blueprints).some((a) => a.id === id);
}

/** Rotations with a registered blueprint, for the form's rotation picker. */
export function blueprintRotations(blueprints: Blueprints = STATS_BLUEPRINTS): string[] {
  return Object.keys(blueprints);
}
