/**
 * Workplace-based assessment how-to guides.
 *
 * The guide CONTENT lives in `content/clinical/`, not here, and that placement
 * is load-bearing: `content/` is structurally excluded from the FOSS
 * distribution while `src/` is shipped in it. These are institution-specific
 * assessment materials, so the rendering code is public and the material is not.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WbaGuide {
  number: number;
  slug: string;
  title: string;
  format: string;
  oneLine: string;
  howTo: string[];
  rubric?: string[];
  prepare?: string[];
  trap?: string;
  autoFail?: string[];
  resources?: { label: string; href: string }[];
}

export interface WbaSharedRules {
  attempts: string;
  missedDeadline: string;
  assessorMinimum: string;
  portfolio: string;
  allCompulsory: string;
}

/** The viewer fields that decide clinical-guide access (a session.user subset). */
export interface ClinicalViewer {
  betaAccess?: boolean;
  imageTier?: 'standard' | 'copyright';
  institution?: string | null;
}

/**
 * Who may see institution-specific assessment guidance.
 *
 * Rolled out 2026-08-19 from the two `betaAccess` holders to every
 * copyright-tier user. The audience was measured before the gate was chosen:
 * copyright tier is exactly 6 users, all `institution: usyd` with `cah` active.
 * Gating on institution alone would have reached 15 additional standard-tier
 * users — 2.5x the intended audience — so the tier is load-bearing and is NOT
 * interchangeable with institution here.
 *
 * The institution match is required on BOTH paths, including `betaAccess`.
 * These are USyd assessment rules: attempt limits, rubric structure, what an
 * examiner auto-fails. Shown to a student at another school they are not merely
 * irrelevant, they are misleading — and `undf` already exists in the user table,
 * so that is a live case rather than a hypothetical. A manual beta grant is not
 * a licence to be shown another school's marking rules.
 *
 * `imageTier` is nominally about image redistribution rights. Reusing it as the
 * trust signal for other gated material is a deliberate call, not an accident:
 * it is the existing marker for the vetted, signed-in cohort. If the two ever
 * need to diverge, this is the seam to split — give clinical access its own
 * field rather than widening what imageTier means.
 */
export function canViewClinicalGuides(
  viewer: ClinicalViewer | null | undefined,
  guideInstitution: string,
): boolean {
  if (!viewer) return false;
  const viewerInstitution = viewer.institution?.trim().toLowerCase();
  if (!viewerInstitution) return false;
  if (viewerInstitution !== guideInstitution.trim().toLowerCase()) return false;
  return viewer.betaAccess === true || viewer.imageTier === 'copyright';
}

export interface WbaGuideSet {
  institution: string;
  rotation: string;
  sourceVerifiedAt: string;
  shared: WbaSharedRules;
  guides: WbaGuide[];
}

/** Rotations with a published guide set. Everything else hides the entry point. */
const SUPPORTED = new Set(['cah']);

export function isWbaRotationSupported(rotation: string): boolean {
  return SUPPORTED.has(rotation);
}

function guidePath(rotation: string): string {
  return join(process.cwd(), 'content', 'clinical', `${rotation}-wba-guides.json`);
}

export function loadWbaGuides(rotation: string): WbaGuideSet | null {
  if (!isWbaRotationSupported(rotation)) return null;
  const path = guidePath(rotation);
  if (!existsSync(path)) return null;
  const set = JSON.parse(readFileSync(path, 'utf8')) as WbaGuideSet;
  return {
    ...set,
    guides: [...set.guides].sort((a, b) => a.number - b.number),
  };
}

export function wbaGuideBySlug(rotation: string, slug: string): WbaGuide | null {
  return loadWbaGuides(rotation)?.guides.find((g) => g.slug === slug) ?? null;
}
