/**
 * Clinical Parser - Pattern Definitions
 *
 * Regex patterns for extracting structured clinical data from question stems.
 * These handle the variability of medical language.
 */

// Demographics patterns
export const DEMOGRAPHICS_PATTERNS = {
  // "65-year-old woman", "72 yo male", "3-month-old infant"
  // Captures: [1]=age, [2]=unit, [3]=sex
  ageAndSex: /(\d+)[- ]?(year|yr|y\.?o\.?|month|mo|week|wk|day|d)[- ]?(?:old)?\s*(?:,?\s*)?(male|female|man|woman|boy|girl|infant|neonate|M|F)\b/i,

  // Just age if sex is separate: "A 45-year-old presents..."
  // Captures: [1]=age, [2]=unit
  // Negative lookahead prevents matching rates like "40/min" or "40 bpm"
  ageOnly: /\b(\d+)[- ]?(year|yr|y\.?o\.?|month|mo|week|wk|day|d)?[- ]?(?:old)?(?!\/|\s*(?:bpm|per|min|beats))\b/i,

  // Just sex if age is separate
  sexOnly: /\b(male|female|man|woman|boy|girl)\b/i,

  // Pediatric age patterns - check these FIRST (more specific)
  // Captures: [1]=age, [2]=unit, [3]=sex (optional)
  pediatricAge: /(\d+)[- ]?(month|mo|week|wk|day|d)[- ]?(?:old)?\s*(?:,?\s*)?(male|female|boy|girl|infant|neonate)?/i,
};

// Vital signs patterns - capture both numeric and qualitative
export const VITAL_PATTERNS = {
  // Heart rate: "HR 120", "heart rate of 95", "pulse 88"
  hr: /(?:heart\s*rate|HR|pulse)(?:\s*(?:of|is|:))?\s*(\d+)\s*(?:bpm|beats?\s*per\s*min(?:ute)?)?/i,
  hrQualitative: /\b(tachycardi[ac]|bradycardi[ac])\b/i,

  // Blood pressure: "BP 90/60", "blood pressure 140/90"
  bp: /(?:BP|blood\s*pressure)(?:\s*(?:of|is|:))?\s*(\d+)\s*\/\s*(\d+)\s*(?:mmHg)?/i,
  bpQualitative: /\b(hypotensive|hypertensive|normotensive)\b/i,

  // Temperature: "temp 38.5", "febrile to 39.2", "temperature 37.8°C"
  temp: /(?:temp(?:erature)?|T)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*°?\s*[CF]?/i,
  tempQualitative: /\b(febrile|afebrile|hypothermi[ac]|hyperthermi[ac])\b/i,

  // Respiratory rate: "RR 24", "respiratory rate 18"
  rr: /(?:respiratory\s*rate|RR|resp(?:s|irations)?)(?:\s*(?:of|is|:))?\s*(\d+)\s*(?:\/min(?:ute)?)?/i,
  rrQualitative: /\b(tachypn[eo]ic|bradypn[eo]ic)\b/i,

  // SpO2: "SpO2 94%", "oxygen saturation 88%", "sats 92"
  spo2: /(?:SpO2|O2\s*sat(?:uration)?|sat(?:uration)?s?|oxygen\s*sat(?:uration)?)(?:\s*(?:of|is|:))?\s*(\d+)\s*%?/i,
  spo2Qualitative: /\b(hypoxic|hypox[ae]mi[ac])\b/i,

  // GCS: "GCS 12", "Glasgow Coma Scale 8"
  gcs: /(?:GCS|Glasgow\s*(?:Coma\s*)?(?:Scale|Score)?)(?:\s*(?:of|is|:))?\s*(\d+)/i,
  gcsQualitative: /\b(obtunded|drowsy|confused|alert|unresponsive|comatose)\b/i,
};

// Lab value patterns - flexible to handle various formats
export const LAB_PATTERNS = {
  // Generic pattern for "name: value unit" or "name of value"
  // Will be applied with specific lab names
  generic: (name: string) => new RegExp(
    `${name}(?:\\s*(?:of|is|:))?\\s*([\\d.]+)\\s*(${COMMON_UNITS.join('|')})?`,
    'i'
  ),

  // Specific patterns for tricky labs
  lactate: /(?:lact(?:ate|ic\s*acid))(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(mmol\/L)?/i,
  glucose: /(?:glucose|BSL|BGL|blood\s*sugar)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(mmol\/L)?/i,

  // Electrolytes often in a panel
  sodium: /(?:sodium|Na\+?)(?:\s*(?:of|is|:))?\s*(\d+)\s*(mmol\/L|mEq\/L)?/i,
  potassium: /(?:potassium|K\+?)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(mmol\/L|mEq\/L)?/i,

  // Renal
  creatinine: /(?:creatinine|Cr)(?:\s*(?:of|is|:))?\s*(\d+)\s*(μmol\/L|umol\/L)?/i,
  urea: /(?:urea|BUN)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(mmol\/L)?/i,
  egfr: /(?:eGFR|GFR)(?:\s*(?:of|is|:))?\s*(\d+)/i,

  // Haematology
  haemoglobin: /(?:haemoglobin|hemoglobin|Hb|Hgb)(?:\s*(?:of|is|:))?\s*(\d+)\s*(g\/L|g\/dL)?/i,
  wbc: /(?:WBC|white\s*(?:blood\s*)?(?:cell\s*)?(?:count)?|leukocytes?)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(×?10[⁹9]\/L)?/i,
  platelets: /(?:platelets?|PLT|plt\s*count)(?:\s*(?:of|is|:))?\s*(\d+)\s*(×?10[⁹9]\/L)?/i,
  neutrophils: /(?:neutrophils?|ANC|absolute\s*neutrophil\s*count)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(×?10[⁹9]\/L)?/i,

  // Coagulation
  inr: /(?:INR)(?:\s*(?:of|is|:))?\s*([\d.]+)/i,
  aptt: /(?:APTT|aPTT|PTT)(?:\s*(?:of|is|:))?\s*(\d+)\s*(?:seconds?|s)?/i,

  // Liver
  bilirubin: /(?:bilirubin|bili)(?:\s*(?:of|is|:))?\s*(\d+)\s*(μmol\/L|umol\/L)?/i,
  alt: /(?:ALT|alanine\s*(?:amino)?transferase)(?:\s*(?:of|is|:))?\s*(\d+)\s*(U\/L|IU\/L)?/i,
  ast: /(?:AST|aspartate\s*(?:amino)?transferase)(?:\s*(?:of|is|:))?\s*(\d+)\s*(U\/L|IU\/L)?/i,
  alp: /(?:ALP|alkaline\s*phosphatase)(?:\s*(?:of|is|:))?\s*(\d+)\s*(U\/L|IU\/L)?/i,
  ggt: /(?:GGT|gamma[- ]?GT)(?:\s*(?:of|is|:))?\s*(\d+)\s*(U\/L|IU\/L)?/i,
  albumin: /(?:albumin)(?:\s*(?:of|is|:))?\s*(\d+)\s*(g\/L)?/i,

  // Cardiac
  troponin: /(?:troponin|trop|hs[- ]?TnI|hs[- ]?TnT)(?:\s*(?:of|is|:))?\s*(\d+)\s*(ng\/L)?/i,
  bnp: /(?:BNP|NT[- ]?proBNP)(?:\s*(?:of|is|:))?\s*(\d+)\s*(pg\/mL)?/i,

  // Inflammatory
  crp: /(?:CRP|C[- ]?reactive\s*protein)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(mg\/L)?/i,
  procalcitonin: /(?:procalcitonin|PCT)(?:\s*(?:of|is|:))?\s*([\d.]+)\s*(ng\/mL)?/i,

  // Blood gas
  ph: /(?:\bpH\b)(?:\s*(?:of|is|:))?\s*([\d.]+)/i,
  pao2: /(?:PaO2|paO2)\s*(?:of|is|:)?\s*(\d+)\s*(mmHg)?/i, // Require explicit PaO2, not just pO2
  paco2: /(?:PaCO2|paCO2|pCO2)(?:\s*(?:of|is|:))?\s*(\d+)\s*(mmHg)?/i,
  baseExcess: /(?:base\s*excess|BE)(?:\s*(?:of|is|:))?\s*([+-]?[\d.]+)\s*(mmol\/L)?/i,
};

// Common units for generic matching
const COMMON_UNITS = [
  'mmol/L', 'mEq/L', 'mg/L', 'mg/dL', 'g/L', 'g/dL',
  'μmol/L', 'umol/L', 'ng/L', 'ng/mL', 'pg/mL',
  'U/L', 'IU/L', '×10⁹/L', 'x10\\^9/L', '10\\^9/L',
  'mmHg', '%', 's', 'seconds',
];

// Patterns for missing/malformed values (for quality flagging)
export const MALFORMED_PATTERNS = {
  // Unit without value: "lactate mmol/L", "creatinine μmol/L"
  // Also handles "lactic acid is measured at mmol/L" with optional words in between
  unitWithoutValue: new RegExp(
    `(lact(?:ate|ic\\s*acid)|glucose|sodium|potassium|creatinine|haemoglobin|hemoglobin|WBC|platelets?)` +
    `(?:\\s+(?:is|of|at|was|measured|level|levels|value)?)*` + // optional connecting words
    `\\s+(${COMMON_UNITS.join('|')})` +
    `(?!\\s*\\d)`, // negative lookahead - no number after unit
    'gi'
  ),

  // Value placeholder: "lactate of [X]", "BP _/__"
  placeholder: /(?:\[[\w\s]*\]|_{2,}|\?\?+)/g,

  // Incomplete range: "normal range:" without values
  incompleteRange: /(?:normal|reference)\s*range\s*:?\s*$/i,
};

// Timeline/temporal patterns
export const TIMELINE_PATTERNS = {
  // "day 4", "hospital day 2", "HD#3"
  hospitalDay: /(?:hospital\s*)?day\s*#?\s*(\d+)|HD\s*#?\s*(\d+)/gi,

  // "2 weeks ago", "3 days prior"
  durationAgo: /(\d+)\s*(day|week|month|year)s?\s*(?:ago|prior|before|previously)/gi,

  // "on admission", "at presentation"
  admission: /(?:on|at|upon)\s*(?:admission|presentation|arrival)/gi,

  // "post-operative day 2", "POD 1"
  postOp: /(?:post[- ]?operative\s*day|POD)\s*#?\s*(\d+)/gi,
};

// Context patterns
export const CONTEXT_PATTERNS = {
  // Setting
  inpatient: /\b(?:inpatient|admitted|hospitalized|in\s*hospital|ward)\b/i,
  outpatient: /\b(?:outpatient|clinic|office|GP|primary\s*care)\b/i,
  ed: /\b(?:ED|emergency\s*department|A&E|ER|casualty)\b/i,
  icu: /\b(?:ICU|intensive\s*care|critical\s*care|HDU)\b/i,

  // Treatment context
  chemo: /\b(?:chemotherapy|chemo|induction\s*(?:chemo(?:therapy)?)|consolidation|cycle\s*\d+)\b/i,
  postSurgery: /\b(?:post[- ]?(?:op(?:erative)?|surgery|surgical)|after\s*surgery)\b/i,

  // Immunocompromised indicators
  immunocompromised: /\b(?:immunocompromised|immunosuppressed|neutropenic|transplant|HIV|AIDS)\b/i,
};

// Symptom/sign patterns (common clinical presentations)
export const SYMPTOM_PATTERNS = [
  { pattern: /\b(?:rigors?|rigoring|shaking\s*chills?)\b/i, name: 'rigors' },
  { pattern: /\b(?:dyspnoea|dyspnea|dyspneic|dyspnoeic|shortness\s*of\s*breath|SOB|breathless)\b/i, name: 'dyspnoea' },
  { pattern: /\b(?:chest\s*pain|angina)\b/i, name: 'chest pain' },
  { pattern: /\b(?:headache|cephalgia)\b/i, name: 'headache' },
  { pattern: /\b(?:abdominal\s*pain|belly\s*pain)\b/i, name: 'abdominal pain' },
  { pattern: /\b(?:nausea|vomiting|N&V|N\/V)\b/i, name: 'nausea/vomiting' },
  { pattern: /\b(?:diarrh[oe]a|loose\s*stools?)\b/i, name: 'diarrhoea' },
  { pattern: /\b(?:confusion|altered\s*mental|disoriented|deliri(?:um|ous))\b/i, name: 'confusion' },
  { pattern: /\b(?:syncope|(?<!ventricular\s)(?<!RV\s)(?<!LV\s)(?<!cardiovascular\s)collapse(?:d|s)?|passed\s*out|faint(?:ed|ing)?|LOC)\b/i, name: 'syncope' },
  { pattern: /\b(?:seizure|convulsion|fitting)\b/i, name: 'seizure' },
  { pattern: /\b(?:oedema|edema|swelling|swollen)\b/i, name: 'oedema' },
  { pattern: /\b(?:cough(?:ing)?)\b/i, name: 'cough' },
  { pattern: /\b(?:haemoptysis|hemoptysis|coughing\s*(?:up\s*)?blood)\b/i, name: 'haemoptysis' },
  { pattern: /\b(?:haematemesis|hematemesis|vomiting\s*blood)\b/i, name: 'haematemesis' },
  { pattern: /\b(?:melaena|melena|black\s*stool)\b/i, name: 'melaena' },
  { pattern: /\b(?:haematuria|hematuria|blood\s*in\s*urine)\b/i, name: 'haematuria' },
  { pattern: /\b(?:oliguria|anuria|reduced\s*urine)\b/i, name: 'oliguria' },
  { pattern: /\b(?:jaundice|icteric|yellow(?:ing)?)\b/i, name: 'jaundice' },
  { pattern: /\b(?:rash|urticaria|hives)\b/i, name: 'rash' },
  { pattern: /\b(?:pallor|pale)\b/i, name: 'pallor' },
  { pattern: /\b(?:cyanosis|cyanotic|blue)\b/i, name: 'cyanosis' },
  { pattern: /\b(?:lethargy|lethargic|fatigue|tired)\b/i, name: 'lethargy' },
  { pattern: /\b(?:weight\s*loss)\b/i, name: 'weight loss' },
  { pattern: /\b(?:fever|pyrexia)\b/i, name: 'fever' },
];

// Question stem detection - does this look like a clinical scenario?
export const CLINICAL_INDICATORS = {
  // Strong indicators of clinical scenario
  hasPatient: /\b(?:\d+[- ]?(?:year|yr|y\.?o|month|mo)[- ]?old|patient|man|woman|boy|girl)\b/i,
  hasPresentation:
    /\b(?:presents?|presenting|admitted|brought\s*in|comes?\s*to|seen\s*in|inpatient|hospital\s*day|has\s+(?:a|an|been|developed?)|with\s+(?:a|an|known|severe|history)|suffering\s*from|experiencing|develops?|found\s*to\s*have|diagnosed\s*with|complaining\s*of|collapses?|collapsed|requires\s*(?:emergency|urgent|immediate)|needs?\s*(?:emergency|urgent))\b/i,
  hasVitals:
    /\b(?:HR|BP|MAP|GCS|temp|RR|SpO2|sats?|heart\s*rate|blood\s*pressure|mean\s*arterial|vital|hypotensive|hypertensive|febrile|tachycardi|bradycardi|oxygen\s*saturation|urine\s*output|desaturat)/i,
  hasLabs:
    /\b(?:lact(?:ate|ic\s*acid)|WBC|creatinine|haemoglobin|hemoglobin|platelets?|sodium|potassium|troponin|ABG|pH|PaO2|PaCO2|glucose|INR|BNP)/i,
  hasClinicalCondition:
    /\b(?:septic\s*shock|septic|sepsis|shock|MI|STEMI|NSTEMI|stroke|CVA|PE|pulmonary\s*embolism|DKA|pneumonia|ACS|arrest|cardiac\s*arrest|trauma|burn|seizure|status\s*epilepticus|intubat|ventilat|resuscitat|asthma|COPD|heart\s*failure|CHF|renal\s*failure|AKI|CKD|spinal\s*cord\s*injury)\b/i,

  // Strong indicators of NON-clinical scenario (definitions, mechanisms)
  isDefinition:
    /\b(?:which\s*of\s*the\s*following\s*(?:best\s*)?describes?|the\s*(?:mechanism|pathophysiology|definition)\s*of)\b/i,
  isList: /\b(?:which\s*(?:one\s*)?is\s*(?:not\s*)?(?:a|an|true|false|correct|incorrect))\b/i,
};

// Extract the actual question from stem
export const QUESTION_PATTERNS = {
  // Matches common MCQ question formats:
  // - "Which of the following...", "Which is...", "Which drug...", "Which component..."
  // - "What is...", "What are...", "What would...", "What change...", "What drug..."
  // - "How should...", "How would..."
  // - "The most likely/appropriate..."
  // - "Your first/next/immediate..."
  // - "The best/next step/action/investigation..."
  questionStart: /\b(which\s+(?:of\s+the\s+following|is|are|drug|component|patient|finding|intervention|treatment|medication|investigation|test|diagnosis|condition|factor|statement|option)\b|what\s+(?:is|are|would|should|change|drug|treatment|intervention|diagnosis|investigation)\b|how\s+(?:should|would|do|does)\b|the\s+most\s+(?:likely|appropriate|common|important|accurate|sensitive|specific)\b|your\s+(?:first|next|immediate)\b|the\s+(?:best|next|first|initial|most\s+appropriate)\s+(?:step|action|investigation|treatment|management|approach|intervention))/i,
};
