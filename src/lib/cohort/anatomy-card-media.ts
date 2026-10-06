import type { AnatomyFigureId, AnatomyFigureTarget } from './anatomy-figure-catalogue';
/**
 * The small, closed registry of reviewed illustrations that may accompany a
 * public anatomy card.  Cards opt in by their exact released stableId; text
 * similarity, titles and URLs are deliberately not used here.
 */

export type AnatomyCardMediaRole = 'prompt' | 'supplementary';

export interface AnatomyCardMediaDescriptor {
  figureId: AnatomyFigureId;
  target: AnatomyFigureTarget;
  role: AnatomyCardMediaRole;
  preAnswerAlt: string;
  postAnswerAlt: string;
}

const REVIEWED: Readonly<Record<string, AnatomyCardMediaDescriptor>> = Object.freeze({
  // Reviewed distal carpal section: six identification and six relation/application tasks.
  'cohort:anatomy:c-684b1b98be79:v1': {
    figureId: 'carpal-tunnel-focus', target: 'median-nerve', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: median nerve.',
  },
  'cohort:anatomy:c-4282cc332060:v1': {
    figureId: 'carpal-tunnel-focus', target: 'flexor-retinaculum', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: flexor retinaculum.',
  },
  'cohort:anatomy:c-15e3963e7828:v1': {
    figureId: 'carpal-tunnel-focus', target: 'trapezium', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: trapezium.',
  },
  'cohort:anatomy:c-2a9d592a962f:v1': {
    figureId: 'carpal-tunnel-focus', target: 'trapezoid', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: trapezoid.',
  },
  'cohort:anatomy:c-d1c8d35ea537:v1': {
    figureId: 'carpal-tunnel-focus', target: 'capitate', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: capitate.',
  },
  'cohort:anatomy:c-6b1359a45b1f:v1': {
    figureId: 'carpal-tunnel-focus', target: 'hamate', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: hamate.',
  },
  'cohort:anatomy:c-bf996fb12d2d:v1': {
    figureId: 'carpal-tunnel-focus', target: 'median-nerve', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: median nerve.',
  },
  'cohort:anatomy:c-aa0dbbbb964c:v1': {
    figureId: 'carpal-tunnel-focus', target: 'flexor-retinaculum', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: flexor retinaculum.',
  },
  'cohort:anatomy:c-26153cbb8a4b:v1': {
    figureId: 'carpal-tunnel-focus', target: 'trapezium', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: trapezium.',
  },
  'cohort:anatomy:c-4751dcc945eb:v1': {
    figureId: 'carpal-tunnel-focus', target: 'trapezoid', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: trapezoid.',
  },
  'cohort:anatomy:c-e88e67c4dc0c:v1': {
    figureId: 'carpal-tunnel-focus', target: 'capitate', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: capitate.',
  },
  'cohort:anatomy:c-e5041ed26e0b:v1': {
    figureId: 'carpal-tunnel-focus', target: 'hamate', role: 'prompt',
    preAnswerAlt: 'Schematic distal wrist section with structure A marked.',
    postAnswerAlt: 'Schematic distal wrist section with A labelled: hamate.',
  },

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
