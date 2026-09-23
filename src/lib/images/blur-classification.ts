/**
 * Whether a clinical photograph should start blurred.
 *
 * The review gate only fires on an explicit sidecar `sensitive: true`. This
 * classifier is how that flag gets set: from the figure's own text, for
 * photographs and derm images only. Diagrams, scans and ordinary rashes stay
 * clear. A long case history that merely mentions a comorbidity does not
 * describe the photograph.
 *
 * Caption matching is a floor. A multi-panel legend can name a panel this
 * crop does not contain, and a wrong caption can hide a photograph that
 * should blur. Those are reviewed by looking at the pixels.
 */

const PHOTO_MODALITIES = new Set(['photo', 'derm']);

/** Whole words. Matched on casefolded text. */
const BLUR_TERMS = [
  'autopsy', 'necropsy', 'postmortem', 'post-mortem', 'stillborn', 'stillbirth',
  'abortus', 'cadaver', 'cadaveric', 'fetal demise', 'products of conception',
  'genitalia', 'genital', 'genitals', 'perineum', 'perineal', 'perianal',
  'anus', 'anal', 'vulva', 'vulval', 'vagina', 'vaginal', 'scrotum', 'scrotal',
  'penis', 'penile', 'hypospadias', 'epispadias', 'circumcision',
  'clitoral', 'clitoris', 'clitoromegaly', 'labia', 'labial', 'labioscrotal',
  'testis', 'testes', 'testicular', 'breast', 'nipple', 'areola',
  'gynaecomastia', 'gynecomastia', 'balanitis', 'balanoposthitis',
  'uncircumcised', 'circumcised', 'foreskin', 'prepuce', 'phimosis',
  'paraphimosis', 'cryptorchidism', 'undescended', 'hydrocele', 'varicocele',
  'vulvovaginitis', 'smegma', 'chordee', 'micropenis', 'buried penis',
  'labial adhesions',
] as const;

/**
 * Phrases where the lexicon word is an idiom or a route of delivery, not the
 * photograph. Removed before matching so a leftover real finding still counts.
 */
const NEUTRAL_PHRASES = [
  'pigeon breast',
  'breast milk',
  'breastfeeding',
  'breast-feeding',
  'breastfed',
  'vaginal delivery',
  'vaginal birth',
  'transvaginal',
];

/**
 * A diagnosis named in passing inside a long patient history, not as the
 * subject of a short figure label.
 */
const HISTORY_ONLY = new Set(['cryptorchidism', 'undescended']);
const HISTORY_ONLY_MAX_LENGTH = 180;

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A single trailing s is the plural ("nipples", "breasts"), not a new word.
  const plural = term.endsWith('s') ? '' : 's?';
  return new RegExp(`(?<![a-z])${escaped}${plural}(?![a-z])`, 'i');
}

export function clinicalPhotoNeedsBlur(input: {
  modality?: string | null;
  texts: Array<string | null | undefined>;
}): boolean {
  if (!input.modality || !PHOTO_MODALITIES.has(input.modality)) return false;
  const raw = input.texts
    .filter((text): text is string => typeof text === 'string' && text.trim() !== '')
    .join('\n')
    .toLowerCase();
  if (!raw) return false;

  let text = raw;
  for (const phrase of NEUTRAL_PHRASES) {
    text = text.replaceAll(phrase, ' ');
  }

  const historyOnly = raw.length > HISTORY_ONLY_MAX_LENGTH;
  const matched = BLUR_TERMS.filter((term) => {
    if (historyOnly && HISTORY_ONLY.has(term)) return false;
    return termPattern(term).test(text);
  });
  // A pathology specimen is not an exposed breast. Genital specimens still blur.
  if (/\bexcised\b/.test(text)) {
    const breastOnly = new Set(['breast', 'nipple', 'areola', 'gynaecomastia', 'gynecomastia']);
    if (matched.every((term) => breastOnly.has(term))) return false;
  }
  return matched.length > 0;
}

/**
 * The flag a new sidecar should store. An explicit false is a reviewed-safe
 * verdict. An explicit true is a reviewed blur. Otherwise the figure text
 * decides, and a sibling sidecar for the same bytes keeps its blur: a later
 * role copy often stores a shortened condition that no longer names the anatomy.
 */
export function resolveClinicalBlur(input: {
  explicit?: boolean;
  modality?: string | null;
  texts: Array<string | null | undefined>;
  siblingSensitive?: boolean;
}): boolean {
  if (input.explicit === false) return false;
  if (input.explicit === true) return true;
  return clinicalPhotoNeedsBlur({ modality: input.modality, texts: input.texts })
    || input.siblingSensitive === true;
}
