export interface ClinicalAudienceViewer {
  institution?: string | null;
  track?: number | null;
  imageTier?: string | null;
  betaAccess?: boolean | null;
}

/** Public build: no institution calendar, so no stream is on a rotation. */
export function trackRotationAt(_track: number | null | undefined, _now: Date = new Date()): string | null {
  void _track;
  void _now;
  return null;
}

/** Public build: no clinical stations or institution guides, so no rotation audience. */
export function currentRotationAudiences(_viewer: ClinicalAudienceViewer, _now: Date = new Date()): string[] {
  void _viewer;
  void _now;
  return [];
}
