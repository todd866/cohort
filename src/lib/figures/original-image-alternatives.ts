/** Private-course associations are omitted. Add reviewed mappings for your own content. */
export interface OriginalImageIdentity { type: 'card' | 'question'; id: string }
export interface OriginalImageAlternative { figureId: string; imageCaption: string; expectedPrimaryKey: string | null; teachingFingerprint: string }
export function getOriginalImageAlternatives(_identity: OriginalImageIdentity): readonly OriginalImageAlternative[] {
  void _identity;
  return [];
}
