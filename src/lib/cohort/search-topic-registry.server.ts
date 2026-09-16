import 'server-only';

import {
  COHORT_SEARCH_MODALITIES,
  type CohortSearchModality,
  type CohortSearchTopicV1,
} from './search-topic-contract';

export interface CohortSearchTopicDefinition {
  id: string;
  label: string;
  aliases: readonly string[];
  searchIntents: readonly string[];
  learningOutcomes: readonly string[];
  familyIds: readonly string[];
  /** Exact, curated Question.topics matches. Server-only policy identity. */
  publicTopicTags: readonly string[];
  modalities: readonly CohortSearchModality[];
}

/**
 * Stable, reviewed search identity for Cohort. Entries may be admitted before
 * their first content pack, but zero-eligible entries never cross the API.
 * Arbitrary Question.topics and learner prose are never registry authority.
 */
export const COHORT_SEARCH_TOPIC_REGISTRY = [
  {
    id: 'ecg-basics',
    label: 'ECG basics',
    aliases: ['ECG', 'EKG', 'electrocardiogram', 'heart tracing', 'cardiac tracing'],
    searchIntents: ['how to read an ECG', 'understand ECG waves', 'learn cardiac electrophysiology'],
    learningOutcomes: ['Connect ECG deflections to cardiac electrical events.'],
    familyIds: ['cardiac-electrophysiology'],
    publicTopicTags: ['electrocardiogram', 'cardiac electrophysiology'],
    modalities: ['text', 'ecg'],
  },
  {
    id: 'diabetes-glucose',
    label: 'Diabetes and glucose',
    aliases: ['diabetes', 'blood sugar', 'glucose', 'insulin', 'HbA1c', 'DKA'],
    searchIntents: ['understand diabetes', 'how insulin controls blood sugar', 'learn glucose metabolism'],
    learningOutcomes: [
      'Connect insulin, glucose handling, and diabetes physiology.',
      'Recognise core mechanisms behind diabetic ketoacidosis and HbA1c.',
    ],
    familyIds: ['diabetes-glucose'],
    publicTopicTags: [
      'blood glucose',
      'diabetes',
      'diabetes mellitus',
      'diabetic ketoacidosis',
      'glucose absorption',
      'glucose uptake',
      'glycolysis',
      'glycolysis regulation',
      'hemoglobin a1c',
      'insulin',
      'pancreatic beta cells',
      'sodium-glucose cotransport',
      'type 1 diabetes',
      'type 2 diabetes',
    ],
    modalities: ['text'],
  },
  {
    id: 'heart-function',
    label: 'How the heart works',
    aliases: ['heart', 'cardiac physiology', 'heart attack', 'heart failure', 'cardiac output', 'cardiac cycle', 'heart sounds'],
    searchIntents: ['understand how the heart pumps', 'learn the cardiac cycle', 'understand heart failure'],
    learningOutcomes: [
      'Relate filling, contraction, valves, and flow through one cardiac cycle.',
      'Connect cardiac output and stroke volume to heart failure physiology.',
    ],
    familyIds: ['heart-function'],
    publicTopicTags: [
      'cardiac anatomy',
      'cardiac cycle',
      'cardiac function',
      'cardiac muscle',
      'cardiac output',
      'frank-starling mechanism',
      'heart',
      'heart attack',
      'heart failure',
      'heart murmur',
      'heart sounds',
      'heart valves',
      'mechanical heart valve',
      'stroke volume',
    ],
    modalities: ['text'],
  },
  {
    id: 'blood-pressure',
    label: 'Blood pressure',
    aliases: ['blood pressure', 'BP', 'mean arterial pressure', 'MAP', 'baroreceptors', 'vascular resistance'],
    searchIntents: ['understand blood pressure', 'how the body controls blood pressure', 'learn mean arterial pressure'],
    learningOutcomes: [
      'Connect cardiac output and vascular resistance to arterial pressure.',
      'Predict the baroreceptor response to a change in blood pressure.',
    ],
    familyIds: ['blood-pressure-heart'],
    publicTopicTags: [
      'baroreceptor reflex',
      'blood pressure',
      'blood pressure regulation',
      'hypertension',
      'mean arterial pressure',
      "poiseuille's law",
      'vascular resistance',
    ],
    modalities: ['text'],
  },
  {
    id: 'asthma-breathing',
    label: 'Asthma and breathing',
    aliases: ['asthma', 'breathing', 'lungs', 'respiratory physiology', 'gas exchange', 'lung compliance', 'lung volumes'],
    searchIntents: ['understand asthma', 'how breathing and gas exchange work', 'learn lung mechanics'],
    learningOutcomes: [
      'Connect airway mechanics to asthma symptoms and treatment targets.',
      'Reason from ventilation and diffusion to gas exchange.',
    ],
    familyIds: ['asthma-respiration'],
    publicTopicTags: [
      'airway resistance',
      'asthma',
      'gas exchange',
      'lung compliance',
      'lung volumes and capacities',
      'neonatal respiratory distress',
      'respiratory acidosis',
      'respiratory centers',
      'respiratory membrane',
      'restrictive lung disease',
      'ventilation',
    ],
    modalities: ['text'],
  },
  {
    id: 'kidney-fluid-balance',
    label: 'Kidneys and fluid balance',
    aliases: ['kidneys', 'kidney disease', 'renal', 'nephron', 'nephrotic syndrome', 'fluid balance', 'electrolytes', 'ADH', 'RAAS'],
    searchIntents: ['understand the kidneys', 'how the nephron handles water and salt', 'learn fluid and acid-base balance'],
    learningOutcomes: [
      'Trace filtration and reabsorption through the nephron.',
      'Connect ADH, renin, and aldosterone to water and pressure control.',
    ],
    familyIds: ['kidney-fluid-electrolytes'],
    publicTopicTags: [
      'adh',
      'adh release',
      'adh synthesis',
      'aldosterone',
      'bicarbonate reabsorption',
      'chronic kidney disease',
      'glomerular filtration barrier',
      'glomerular protein loss',
      'kidney',
      'kidneys',
      'nephrogenic diabetes insipidus',
      'nephrotic syndrome',
      'proximal tubule',
      'reabsorption',
      'renal compensation',
      'renal endocrine function',
      'renin-angiotensin',
      'renin-angiotensin system',
      'tubuloglomerular feedback',
    ],
    modalities: ['text'],
  },
  {
    id: 'stroke',
    label: 'Stroke',
    aliases: ['stroke', 'brain attack', 'cerebrovascular accident', 'CVA', 'brain emergency'],
    searchIntents: ['recognise a stroke', 'understand stroke mechanisms', 'learn urgent stroke treatment'],
    learningOutcomes: [
      'Recognise core stroke patterns and the logic of urgent treatment.',
      'Connect vascular mechanism to neurologic deficit.',
    ],
    familyIds: ['stroke-neurologic-emergency'],
    publicTopicTags: ['cerebral circulation', 'neurologic emergency', 'stroke'],
    modalities: ['text'],
  },
  {
    id: 'vaccines-immunity',
    label: 'Vaccines and immunity',
    aliases: ['vaccines', 'vaccination', 'immunity', 'immune system', 'immunisation', 'immunization', 'MMR', 'flu vaccine', 'live vaccine', 'inactivated vaccine'],
    searchIntents: ['how vaccines work', 'understand active and passive immunity', 'learn vaccine types'],
    learningOutcomes: [
      'Distinguish active, passive, live, inactivated, and conjugate immunity.',
      'Connect vaccine design to the immune response it produces.',
    ],
    familyIds: ['infection-vaccines'],
    publicTopicTags: [
      'active immunity',
      'adaptive immunity',
      'conjugate vaccines',
      'humoral immunity',
      'immunology',
      'inactivated vaccines',
      'innate immunity',
      'live attenuated vaccines',
      'passive immunity',
      'vaccination',
      'vaccination principles',
      'vaccine classification',
      'vaccine replication',
      'vaccine serology',
      'vaccines',
    ],
    modalities: ['text'],
  },
  {
    id: 'infections',
    label: 'Infections',
    aliases: ['infection', 'infectious diseases', 'microbiology', 'bacteria', 'viruses', 'pathogens', 'flu', 'influenza', 'hepatitis', 'measles', 'mumps', 'rubella', 'tetanus', 'pertussis', 'polio', 'shingles'],
    searchIntents: ['learn common infections', 'how infections spread', 'recognise important pathogens'],
    learningOutcomes: [
      'Connect pathogen structure and transmission to clinical disease.',
      'Recognise high-yield bacterial and viral patterns.',
    ],
    familyIds: ['infection-pathogens'],
    publicTopicTags: [
      'diphtheria',
      'hepatitis a',
      'hepatitis b',
      'hepatitis c',
      'influenza',
      'measles',
      'microbiology',
      'mumps',
      'pertussis',
      'polio',
      'rubella',
      'tetanus',
      'transmission',
      'zoster',
    ],
    modalities: ['text'],
  },
  {
    id: 'blood-oxygen-anemia',
    label: 'Blood, oxygen, and anaemia',
    aliases: ['blood', 'anaemia', 'anemia', 'haemoglobin', 'hemoglobin', 'erythropoietin', 'iron deficiency', 'sickle cell'],
    searchIntents: ['understand anaemia', 'how blood carries oxygen', 'learn sickle cell disease'],
    learningOutcomes: [
      'Connect haemoglobin and red-cell physiology to oxygen delivery.',
      'Distinguish major mechanisms of iron deficiency and sickling.',
    ],
    familyIds: ['blood-oxygen-anemia'],
    publicTopicTags: [
      'anemia',
      'erythrocyte',
      'erythropoiesis',
      'erythropoietin',
      'fetal hemoglobin',
      'hemoglobin',
      'hemoglobin a1c',
      'hemoglobin s',
      'iron absorption',
      'iron deficiency',
      'iron deficiency anemia',
      'macrocytic anemia',
      'microcytic anemia',
      'oxygen',
      'oxygen transport',
      'oxygen unloading',
      'oxygen-hemoglobin dissociation',
      'pernicious anemia',
      'sickle cell disease',
    ],
    modalities: ['text'],
  },
  {
    id: 'clotting-blood-thinners',
    label: 'Clotting and blood thinners',
    aliases: ['blood clotting', 'coagulation', 'haemostasis', 'hemostasis', 'blood thinners', 'anticoagulants', 'heparin', 'platelets'],
    searchIntents: ['understand blood clotting', 'how anticoagulants work', 'learn platelets and fibrinolysis'],
    learningOutcomes: [
      'Order the major steps of platelet plug and fibrin clot formation.',
      'Connect anticoagulant and antiplatelet drugs to their targets.',
    ],
    familyIds: ['hemostasis-clotting'],
    publicTopicTags: [
      'anticoagulant',
      'anticoagulation',
      'antiplatelet',
      'blood clots',
      'coagulation',
      'coagulation cascade',
      'fibrinolysis',
      'hemostasis',
      'heparin',
      'platelet',
      'platelet plug',
      'platelets',
    ],
    modalities: ['text'],
  },
  {
    id: 'thyroid-adrenal-hormones',
    label: 'Thyroid, adrenal, and hormones',
    aliases: ['hormones', 'endocrine', 'thyroid', 'hypothyroidism', 'adrenal', 'adrenal insufficiency', 'cortisol', 'ACTH', 'parathyroid', 'PTH'],
    searchIntents: ['understand hormone feedback', 'learn thyroid physiology', 'learn cortisol and the adrenal gland'],
    learningOutcomes: [
      'Trace thyroid and adrenal hormone synthesis and feedback.',
      'Connect gland, hormone, and target-organ physiology.',
    ],
    familyIds: ['endocrine-hormones'],
    publicTopicTags: [
      'acth',
      'adrenal cortex',
      'adrenal cortex zones',
      'adrenal crisis',
      'adrenal medulla',
      'cortisol',
      'growth hormone',
      'hormone receptor classes',
      'hormone regulation',
      'hypercortisolism',
      'hyperparathyroidism',
      'hypothalamic-pituitary-adrenal axis',
      'hypothyroidism',
      'parathyroid hormone',
      'primary adrenal insufficiency',
      'secondary adrenal insufficiency',
      'steroid hormones',
      'tertiary adrenal insufficiency',
      'thyroid hormone synthesis',
    ],
    modalities: ['text'],
  },
  {
    id: 'digestion-liver',
    label: 'Digestion and the liver',
    aliases: ['digestion', 'gut', 'gastrointestinal', 'stomach', 'gastric acid', 'liver', 'bile', 'CCK', 'secretin', 'absorption'],
    searchIntents: ['understand digestion', 'how the stomach and intestines work', 'learn liver and bile physiology'],
    learningOutcomes: [
      'Connect digestive hormones and secretions to nutrient handling.',
      'Trace bile production, absorption, and liver function.',
    ],
    familyIds: ['digestion-liver'],
    publicTopicTags: [
      'absorption surface area',
      'bile',
      'cholecystokinin',
      'cholestasis',
      'gastric acid',
      'gastric emptying',
      'gastric mucosal barrier',
      'gastric phase',
      'gastric secretion',
      'glucose absorption',
      'intrinsic factor',
      'lipid absorption',
      'liver',
      'liver injury',
      'protein digestion',
      'secretin',
      'water absorption',
    ],
    modalities: ['text'],
  },
  {
    id: 'nerves-action-potentials',
    label: 'Nerves and action potentials',
    aliases: ['nerves', 'neurons', 'nerve signals', 'action potential', 'membrane potential', 'refractory period', 'EPSP', 'IPSP', 'autonomic nervous system'],
    searchIntents: ['understand action potentials', 'how nerves send signals', 'learn membrane potentials'],
    learningOutcomes: [
      'Predict how ion movement changes membrane voltage.',
      'Connect action potentials, refractory periods, and synaptic signals.',
    ],
    familyIds: ['neural-signalling'],
    publicTopicTags: [
      'action potential',
      'autonomic nervous system',
      'epsp',
      'ion distributions',
      'ipsp',
      'neuromuscular junction',
      'nicotinic receptor',
      'refractory period',
      'resting membrane potential',
      'saltatory conduction',
    ],
    modalities: ['text'],
  },
  {
    id: 'muscle-movement',
    label: 'Muscle and movement',
    aliases: ['muscle', 'muscle contraction', 'sarcomere', 'skeletal muscle', 'excitation contraction coupling'],
    searchIntents: ['understand muscle contraction', 'how a sarcomere works', 'learn muscle physiology'],
    learningOutcomes: [
      'Connect electrical excitation to calcium and muscle contraction.',
      'Relate sarcomere structure to force and movement.',
    ],
    familyIds: ['muscle-contraction'],
    publicTopicTags: [
      'cardiac muscle',
      'excitation-contraction coupling',
      'fast glycolytic',
      'muscle contraction',
      'muscle fiber types',
      'muscle metabolism',
      'muscle physiology',
      'muscle spindle',
      'muscle twitch',
      'sarcomere',
      'skeletal muscle',
      'smooth muscle',
    ],
    modalities: ['text'],
  },
  {
    id: 'screening-risk',
    label: 'Screening and medical risk',
    aliases: ['screening tests', 'sensitivity', 'specificity', 'incidence', 'prevalence', 'relative risk', 'odds ratio'],
    searchIntents: ['understand screening tests', 'learn sensitivity and specificity', 'interpret medical risk'],
    learningOutcomes: [
      'Interpret sensitivity, specificity, incidence, and prevalence.',
      'Distinguish relative risk, odds ratio, and attributable risk.',
    ],
    familyIds: ['screening-biostatistics'],
    publicTopicTags: [
      'attributable risk',
      'incidence',
      'odds ratio',
      'prevalence',
      'relative risk',
      'risk ratio',
      'screening',
      'sensitivity',
      'specificity',
    ],
    modalities: ['text'],
  },
  {
    id: 'reproduction-pregnancy',
    label: 'Reproduction and early pregnancy',
    aliases: ['reproduction', 'ovulation', 'LH surge', 'menstrual cycle', 'fertilisation', 'fertilization', 'early pregnancy'],
    searchIntents: ['understand the menstrual cycle', 'learn ovulation and fertilisation', 'understand early pregnancy physiology'],
    learningOutcomes: [
      'Connect hormonal feedback to ovulation and the menstrual cycle.',
      'Trace fertilisation and the earliest steps of pregnancy.',
    ],
    familyIds: ['reproduction-pregnancy'],
    publicTopicTags: [
      'early pregnancy',
      'fertilization',
      'fertilization site',
      'lh surge',
      'menstrual cycle',
      'ovulation',
      'positive feedback',
    ],
    modalities: ['text'],
  },
] as const satisfies readonly CohortSearchTopicDefinition[];

export type CohortSearchTopicId = (typeof COHORT_SEARCH_TOPIC_REGISTRY)[number]['id'];
export type CohortSearchTopicRegistryEntry = (typeof COHORT_SEARCH_TOPIC_REGISTRY)[number];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FIELD_CHARS = 180;
const MAX_LIST_ITEMS = 32;

function listErrors(
  topicId: string,
  field: string,
  values: readonly string[],
  options: { lowercase?: boolean; idPattern?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (values.length === 0 || values.length > MAX_LIST_ITEMS) {
    errors.push(`${topicId}.${field} must contain 1..${MAX_LIST_ITEMS} values`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || value.length > MAX_FIELD_CHARS || value !== value.trim()) {
      errors.push(`${topicId}.${field} contains an invalid bounded string`);
    }
    const canonical = value.toLocaleLowerCase('en-US');
    if (seen.has(canonical)) errors.push(`${topicId}.${field} contains duplicate ${value}`);
    seen.add(canonical);
    if (options.lowercase && canonical !== value) {
      errors.push(`${topicId}.${field} must use normalized lowercase values`);
    }
    if (options.idPattern && !ID_PATTERN.test(value)) {
      errors.push(`${topicId}.${field} contains invalid id ${value}`);
    }
  }
  return errors;
}

export function validateCohortSearchTopicRegistry(
  topics: readonly CohortSearchTopicDefinition[],
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const topic of topics) {
    if (!ID_PATTERN.test(topic.id) || topic.id.length > 64) {
      errors.push(`invalid topic id ${topic.id}`);
    }
    if (ids.has(topic.id)) errors.push(`duplicate topic id ${topic.id}`);
    ids.add(topic.id);
    if (topic.label.length === 0 || topic.label.length > 80 || topic.label !== topic.label.trim()) {
      errors.push(`${topic.id}.label is invalid`);
    }
    errors.push(...listErrors(topic.id, 'aliases', topic.aliases));
    errors.push(...listErrors(topic.id, 'searchIntents', topic.searchIntents));
    errors.push(...listErrors(topic.id, 'learningOutcomes', topic.learningOutcomes));
    errors.push(...listErrors(topic.id, 'familyIds', topic.familyIds, { idPattern: true }));
    errors.push(...listErrors(topic.id, 'publicTopicTags', topic.publicTopicTags, { lowercase: true }));
    if (topic.publicTopicTags.some((tag) => tag.startsWith('ladder:'))) {
      errors.push(`${topic.id}.publicTopicTags cannot expose ladder identity`);
    }
    errors.push(...listErrors(topic.id, 'modalities', topic.modalities));
    if (topic.modalities.some((modality) =>
      !(COHORT_SEARCH_MODALITIES as readonly string[]).includes(modality))) {
      errors.push(`${topic.id}.modalities contains an unknown value`);
    }
  }
  return errors;
}

const REGISTRY_ERRORS = validateCohortSearchTopicRegistry(COHORT_SEARCH_TOPIC_REGISTRY);
if (REGISTRY_ERRORS.length > 0) {
  throw new Error(`Invalid Cohort search topic registry: ${REGISTRY_ERRORS.join('; ')}`);
}

const TOPIC_BY_ID = new Map<CohortSearchTopicId, CohortSearchTopicRegistryEntry>(
  COHORT_SEARCH_TOPIC_REGISTRY.map((topic) => [topic.id, topic]),
);

export function isCohortSearchTopicId(value: unknown): value is CohortSearchTopicId {
  return typeof value === 'string' && TOPIC_BY_ID.has(value as CohortSearchTopicId);
}

export function resolveCohortSearchTopic(
  value: unknown,
): CohortSearchTopicRegistryEntry | null {
  return isCohortSearchTopicId(value) ? TOPIC_BY_ID.get(value) ?? null : null;
}

function canonicalTopicTag(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function questionMatchesCohortSearchTopic(
  questionTopics: readonly string[],
  topic: Pick<CohortSearchTopicDefinition, 'publicTopicTags'>,
): boolean {
  const available = new Set(questionTopics.map(canonicalTopicTag));
  return topic.publicTopicTags.some((tag) => available.has(tag));
}

interface SearchablePublicQuestion {
  topics: readonly string[];
  publicProvenance: {
    media?:
      | { kind: 'none' }
      | { kind: 'asset'; assetId: string };
  };
}

export function buildCohortSearchTopics(
  questions: readonly SearchablePublicQuestion[],
): CohortSearchTopicV1[] {
  return COHORT_SEARCH_TOPIC_REGISTRY.flatMap((topic) => {
    const eligible = questions.filter((question) =>
      questionMatchesCohortSearchTopic(question.topics, topic));
    if (eligible.length === 0) return [];

    const assetIds = new Set<string>();
    for (const question of eligible) {
      const media = question.publicProvenance.media;
      if (media?.kind === 'asset') assetIds.add(media.assetId);
    }

    return [{
      id: topic.id,
      label: topic.label,
      aliases: [...topic.aliases],
      searchIntents: [...topic.searchIntents],
      learningOutcomes: [...topic.learningOutcomes],
      modalities: [...topic.modalities],
      eligibleItemCount: eligible.length,
      eligibleAssetCount: assetIds.size,
    }];
  });
}

/** Load only release-eligible FOSS questions, then project an aggregate catalog. */
export async function loadCohortSearchTopics(): Promise<CohortSearchTopicV1[]> {
  // Keep the registry/resolver lightweight for the turn path. Only the profile
  // catalog projection needs to initialize the database-backed public loader.
  const { loadPublicUsmleQuestionCorpus } = await import(
    '@/lib/usmle/public-question-corpus.server'
  );
  const corpus = await loadPublicUsmleQuestionCorpus();
  return buildCohortSearchTopics(corpus.questions);
}
