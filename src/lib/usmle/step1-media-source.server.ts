import 'server-only';

export interface Step1MediaSourcePresentation {
  attributionText: string;
  licenseUrl: string;
  /** False when the source URI or page title would disclose the answer. */
  promptSourcePage: boolean;
}

const STEP1_MEDIA_SOURCE_PRESENTATION = new Map<string, Step1MediaSourcePresentation>([
  ['https://physionet.org/content/ptb-xl/1.0.3/', {
    attributionText: 'Wagner et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    promptSourcePage: true,
  }],
  ['https://physionet.org/content/vtac/1.0/', {
    attributionText: 'Lehman et al. via PhysioNet; Lead II excerpt rendered by MD3 contributors — CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    promptSourcePage: false,
  }],
]);

export function step1MediaSourcePresentation(
  sourcePageUrl: string,
): Step1MediaSourcePresentation | null {
  return STEP1_MEDIA_SOURCE_PRESENTATION.get(sourcePageUrl) ?? null;
}

export function isReviewedStep1MediaSourcePageUrl(sourcePageUrl: string): boolean {
  return STEP1_MEDIA_SOURCE_PRESENTATION.has(sourcePageUrl);
}
