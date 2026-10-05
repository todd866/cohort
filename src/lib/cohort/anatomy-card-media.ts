/**
 * The small, closed registry of reviewed illustrations that may accompany a
 * public anatomy card.  Cards opt in by their exact released stableId; text
 * similarity, titles and URLs are deliberately not used here.
 */

export type AnatomyCardMediaRole = 'prompt' | 'supplementary';

export interface AnatomyCardMediaDescriptor {
  figureId: 'abducens-local';
  target: 'lateral-rectus' | 'abducens' | 'optic-nerve';
  role: AnatomyCardMediaRole;
  preAnswerAlt: string;
  postAnswerAlt: string;
}

const REVIEWED: Readonly<Record<string, AnatomyCardMediaDescriptor>> = Object.freeze({
  // cohort:anatomy:c-dd0bcce3d72d:v1 = originalId lateral-rectus-innervation
  'cohort:anatomy:c-dd0bcce3d72d:v1': {
    figureId: 'abducens-local', target: 'lateral-rectus',
    role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the right lateral rectus and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram showing the right lateral rectus supplied by cranial nerve VI.',
  },
  // cohort:anatomy:c-8dab68bbf8d1:v1 = originalId right-abducens-palsy
  'cohort:anatomy:c-8dab68bbf8d1:v1': {
    figureId: 'abducens-local', target: 'abducens',
    role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the right lateral rectus and the nerve that reaches it.',
    postAnswerAlt: 'Simplified diagram showing the right sixth nerve reaching the lateral rectus; injury weakens abduction.',
  },
  // Reviewed visual-target cards; all use the same bounded figure while the
  // client selects the appropriate hidden-label target state.
  'cohort:anatomy:c-ccf1f2fc532f:v1': {
    figureId: 'abducens-local', target: 'lateral-rectus', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the lateral rectus target identified.',
  },
  'cohort:anatomy:c-bf7970a915a8:v1': {
    figureId: 'abducens-local', target: 'lateral-rectus', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the lateral rectus target identified.',
  },
  'cohort:anatomy:c-db24b4cc28af:v1': {
    figureId: 'abducens-local', target: 'abducens', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the abducens nerve target identified.',
  },
  'cohort:anatomy:c-6b181def3d6b:v1': {
    figureId: 'abducens-local', target: 'abducens', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the abducens nerve target identified.',
  },
  'cohort:anatomy:c-b268867d622e:v1': {
    figureId: 'abducens-local', target: 'optic-nerve', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the optic nerve target identified.',
  },
  'cohort:anatomy:c-ff128ba9fed0:v1': {
    figureId: 'abducens-local', target: 'optic-nerve', role: 'prompt',
    preAnswerAlt: 'Simplified diagram of the eye and nearby ocular motor nerves.',
    postAnswerAlt: 'Simplified diagram with the optic nerve target identified.',
  },
});

/** Return a reviewed descriptor for this exact released card, if one exists. */
export function anatomyCardMediaForStableId(stableId: string): AnatomyCardMediaDescriptor | undefined {
  return REVIEWED[stableId];
}

export const REVIEWED_ANATOMY_MEDIA_STABLE_IDS = Object.freeze(Object.keys(REVIEWED));
