// Explicit presentation cues, not every mention of imaging or a study result.
const VISUAL = String.raw`(?:(?:chest|abdominal|pelvic|cranial|fundoscopic|histology|histological|clinical)\s+)?(?:images?|pictures?|photographs?|photos?|radiographs?|x[-– ]?rays?|xr|films?|ct(?:\s+scans?)?|ctg|mri|mra|ultrasound|sonograms?|echocardiograms?|ecgs?|ekgs?|trac(?:ing|e)s?|waveforms?|flow[-– ]volume\s+loops?|slides?|figures?|diagrams?|clips?|videos?)`;
const PRESENTATION = '(?:shown|pictured|displayed|illustrated|depicted)';
const LOCATION = '(?:here|below|above)';
const PATTERNS = [
  // “ECG is performed and shown”, “radiographs shown”, “MRI of the knee is shown”.
  new RegExp(String.raw`\b${VISUAL}\s*(?:(?:of|during|from)\s+[^.!?;,]{1,45}?\s+)?(?:(?:is|are|was|were)\s+(?:(?:performed|obtained)\s+and\s+)?)?${PRESENTATION}\b`, 'i'),
  // “illustrated in this histology slide”, “shown the chest film”.
  new RegExp(String.raw`\b${PRESENTATION}\s+(?:(?:in|on|by)\s+)?(?:a|an|the|this|these|following)\s+${VISUAL}\b`, 'i'),
  // “the image below”, “the following flow-volume loop”, “accompanying radiograph”.
  new RegExp(String.raw`\b${VISUAL}\s+(?:below|above)\b|\b(?:following|accompanying|attached|above|below)\s+${VISUAL}\b`, 'i'),
  // “What does this ECG show?”, “What abnormality is seen on this X-ray?”
  new RegExp(String.raw`\bwhat\s+(?:does|do)\s+(?:this|these|the)\s+${VISUAL}\s+show\b`, 'i'),
  new RegExp(String.raw`\b(?:what|which)\b[^.!?]{0,90}\b(?:seen|shown|depicted)\s+(?:in|on)\s+(?:this|these|the)\s+${VISUAL}\b`, 'i'),
  // “Which fungus is shown below?” omits the visual noun entirely.
  new RegExp(String.raw`\b(?:what|which)\b[^.!?]{0,90}\b${PRESENTATION}\s+${LOCATION}\b`, 'i'),
  /\b(?:pictured|depicted)\s+(?:here|below|above)\b/i,
  /\b(?:shown|indicated|marked)\s+by\s+(?:the\s+)?(?:(?:yellow|red|blue|green|white|black)\s+)?(?:box|arrows?)\b/i,
  // Cloze prompts may supply neither a visual noun nor an interrogative.
  /\b(?:position|approach|technique)\s+(?:shown|illustrated)\s+(?:here|below|above)\b/i,
];
const CLOZE_VISUAL = new RegExp(String.raw`\b(?:this|these|the)\s+${VISUAL}\s+(?:shows?|demonstrates?|depicts?)\b[^.!?]*\[___\]`, 'i');

/**
 * Flag explicit requests to inspect a visual for review. This pure text detector
 * cannot know whether media is attached, visible, or answer-safe. A positive is
 * a candidate: surrounding prose may already supply the necessary findings.
 * Narrated results (“ECG shows ST elevation”) and evidence (“shown to reduce”)
 * alone are not visual references. Callers must check media availability.
 */
export function promptReferencesUnseenVisual(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  return PATTERNS.some((pattern) => pattern.test(value)) || CLOZE_VISUAL.test(value);
}
