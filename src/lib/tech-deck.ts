/**
 * The cohort.md/tech deck — slides as data.
 *
 * Format follows DeckKit (`~/Projects/DeckKit`): a deck is `{ meta, slides }`
 * and every slide names a layout. Keeping the shape means this deck can later
 * be exported to a real .pptx by that toolchain instead of being screenshotted.
 *
 * EVERY NUMBER HERE IS MEASURED, not estimated, and dated. A stale figure on a
 * page whose whole argument is "we cite our sources" would be self-refuting.
 * Re-measure before changing them.
 */

export interface DeckChip { text: string; accent?: 'primary' | 'muted' }

export interface DeckSlide {
  id: string;
  layout: 'title' | 'hook' | 'metric-grid' | 'equation' | 'steps' | 'takeaways' | 'close';
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  body?: string[];
  chips?: DeckChip[];
  metrics?: Array<{ value: string; label: string }>;
  equation?: string;
  equationNote?: string;
  steps?: Array<{ head: string; detail: string }>;
  takeaways?: string[];
  href?: string;
  hrefLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}

/**
 * The distribution, not the old skeleton.
 *
 * This pointed at md3-open, which is an archived April/July reference
 * implementation with a simplified scheduler and no manifold — so the deck
 * explained embedding-space scheduling and then handed the reader a repo that
 * could not do it. todd866/cohort is the reviewed export of this application:
 * the private manifold scheduler, the simpler public adaptive reviewer and the
 * open Step 1 corpus. "Build your own" is only honest if it points here.
 */
export const TECH_DECK_REPO = 'https://github.com/todd866/cohort';

/** Measured 2026-08-13 against production. */
export const TECH_DECK_MEASURED_ON = '2026-08-13';

export const TECH_DECK: { meta: { title: string; subtitle: string }; slides: DeckSlide[] } = {
  meta: {
    title: 'How this works',
    subtitle: 'Two inspectable learning loops, one open corpus',
  },
  slides: [
    {
      id: 'title',
      layout: 'title',
      eyebrow: 'cohort.md',
      title: 'Spaced repetition,\nbut on concepts',
      subtitle:
        'Cohort changes the next question from your answer history. Private MD3 also uses concept embeddings and exam signals.',
      chips: [
        { text: 'Cohort: difficulty + teaching ladders', accent: 'primary' },
        { text: 'MD3: 3,072D concept embeddings', accent: 'muted' },
        { text: 'Open source', accent: 'muted' },
      ],
    },
    {
      id: 'problem',
      layout: 'hook',
      eyebrow: 'The problem',
      title: 'A card is not a thing you know',
      body: [
        'Get a card right, it disappears for a month. The fact it was testing does not.',
        'Meet the same fact in a different sentence and you fail it — having "reviewed" it yesterday.',
        'The card was never the unit. The concept is.',
      ],
    },
    {
      id: 'manifold',
      layout: 'steps',
      eyebrow: 'The private MD3 engine',
      title: 'Concepts live in one space',
      steps: [
        {
          head: 'Embed the content',
          detail:
            'Every card, question and concept becomes a 3,072-dimensional vector. Similar ideas sit near each other whether or not they share any words.',
        },
        {
          head: 'Track a knowledge vector',
          detail:
            'Your state is a mastery-weighted centroid of the concepts you have touched. It is not static — as retrieval strength decays, the vector drifts.',
        },
        {
          head: 'Aim at the exam',
          detail:
            'The exam is its own centroid in that space. The difference between it and you is a direction, not a score.',
        },
        {
          head: 'Walk the gap',
          detail:
            'The scheduler serves what lies along that direction: nearest neighbours in the region the exam covers and you do not.',
        },
      ],
    },
    {
      id: 'gap',
      layout: 'equation',
      eyebrow: 'Experimental, not a product claim',
      title: 'The centroid gap is designed — and currently inert',
      equation: 'designed gap = exam centroid − learner centroid',
      equationNote:
        'The code exists, but the production courseware-embedding table is empty, so its ranking boost is zero. Private MD3 currently uses vector neighbourhoods plus blueprint signals; Cohort uses answer history, difficulty and teaching ladders.',
    },
    {
      id: 'teaching',
      layout: 'steps',
      eyebrow: 'Get it wrong',
      title: 'Failure should teach, not repeat',
      steps: [
        { head: 'A climber at 4,000 m is short of breath. Weeks later his haemoglobin is up. Why?', detail: 'You miss it.' },
        { head: 'What senses low oxygen?', detail: 'Peritubular cells in the kidney.' },
        { head: 'What do they release?', detail: 'Erythropoietin.' },
        { head: 'What does it do?', detail: 'Drives red cell production — over days, not hours.' },
        { head: 'The climber, again.', detail: 'Now you have it.' },
      ],
    },
    {
      id: 'evidence',
      layout: 'hook',
      eyebrow: 'Provenance',
      title: 'Where a claim comes from',
      body: [
        'Every clinical card carries the sentence that proves it, pulled from primary literature — not from a model\u2019s memory.',
        'Source, tier, jurisdiction, verbatim quote. One click from the card.',
        'Jurisdiction is part of the fact: right for Australian practice can be wrong for a US exam.',
      ],
    },
    {
      id: 'scale',
      layout: 'metric-grid',
      eyebrow: `Measured ${TECH_DECK_MEASURED_ON}`,
      title: 'Current state',
      metrics: [
        { value: '79,284', label: 'cards' },
        { value: '10,445', label: 'questions' },
        { value: '632', label: 'concepts' },
        { value: '10,709', label: 'card citations' },
        { value: '922', label: 'sources' },
        { value: '290,331', label: 'learning events' },
      ],
    },
    {
      // For the builder audience this is the load-bearing claim, and the one
      // that is hard to fake: the unit of knowledge is a parameter, not a
      // constant. GAMSAT has no syllabus, so there are no facts to schedule —
      // the unit becomes the reasoning move and nothing else changes.
      //
      // Also the only route to /gamsat now that the front door is focused on
      // Step 1 and the method. Orphaned by choice, not stranded.
      id: 'generalises',
      layout: 'takeaways',
      eyebrow: 'Same engine, different unit',
      title: 'Not everything worth\nlearning is a fact',
      subtitle:
        'GAMSAT has no syllabus to memorise, so there are no facts to schedule. The unit becomes the reasoning move — and nothing else about the engine changes.',
      chips: [
        { text: 'Necessary versus sufficient' },
        { text: 'Surface the unstated assumption' },
        { text: 'Exhaustive elimination on EXCEPT' },
      ],
      takeaways: [
        '36 named moves across 11 passages, openly licensed.',
        'A missed move enters the same inspectable scheduling contract: outcome history changes what comes next.',
      ],
      href: '/gamsat',
      hrefLabel: 'Try a passage',
    },
    {
      id: 'honest',
      layout: 'takeaways',
      eyebrow: 'What this is not',
      title: 'Claims not made',
      takeaways: [
        'No score prediction. The data would not support one.',
        'Efficacy unproven. Accuracy is tracked over time and reported even when flat.',
        'Mostly one user. Treat the numbers as telemetry, not a study.',
        'Cohort uses a small transparent ranker, not MD3\u2019s private manifold path.',
      ],
    },
    {
      id: 'close',
      layout: 'close',
      eyebrow: 'Now try it',
      title: 'Answer one',
      subtitle:
        'A real Step 1 vignette. Get it right and the next one is harder. Get it wrong and it teaches you the pieces until you can.',
      href: '/',
      hrefLabel: 'Start a question',
      secondaryHref: TECH_DECK_REPO,
      // "Read the source" invites a look; the second audience for this deck is
      // people who would build their own, and the ask should say so.
      secondaryLabel: 'Or build your own',
    },
  ],
};
