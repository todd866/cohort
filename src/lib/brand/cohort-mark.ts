/** cohort.md mark: a lowercase "c." in the md3 tile family. Same 48-unit
 * tile, corner radius and Geist Bold outline as md3-mark.ts, with a white
 * letter and a warm accent, so the two products read as siblings without the
 * Cohort mark repeating md3's letters. The monogram reads the same from the
 * 512px app icon down to the 16px tab. */
import { markVersion } from './md3-mark';

export const COHORT_MARK_LETTER = "M19.674 36.992Q15.85 36.992 13.015 35.387Q10.18 33.781 8.607 30.853Q7.034 27.925 7.034 24Q7.034 20.075 8.607 17.17Q10.18 14.265 13.015 12.637Q15.85 11.008 19.674 11.008Q22.977 11.008 25.585 12.173Q28.193 13.337 29.821 15.504Q31.45 17.671 31.812 20.743L24.639 21.077Q24.304 18.757 22.977 17.574Q21.65 16.39 19.674 16.39Q17.066 16.39 15.637 18.395Q14.208 20.399 14.208 24Q14.208 27.629 15.637 29.633Q17.066 31.638 19.674 31.638Q21.678 31.638 23.019 30.426Q24.36 29.215 24.639 26.682L31.812 26.96Q31.478 30.032 29.877 32.287Q28.276 34.542 25.668 35.767Q23.061 36.992 19.674 36.992Z";
export const COHORT_MARK_DOT = "M33.412 36.435V29.327H40.966V36.435Z";

// Raster assets cannot resolve CSS variables. globals.css repeats these as
// --md-cohort-* for the live navigation tile.
export const COHORT_ICON_BACKGROUND = '#4f46e5';
export const COHORT_ICON_FOREGROUND = '#ffffff';
export const COHORT_ICON_ACCENT = '#fcd34d';

export function cohortIconSvg(size: number, { fullBleed = false, maskable = false } = {}): string {
  const radius = fullBleed ? 0 : size <= 32 ? 10 : 12;
  // A 0.76 scale keeps the mark inside the circular maskable safe zone.
  const transform = maskable ? 'translate(5.76 5.76) scale(.76)' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="${radius}" fill="${COHORT_ICON_BACKGROUND}"/>
  <g transform="${transform}">
    <path fill="${COHORT_ICON_FOREGROUND}" d="${COHORT_MARK_LETTER}"/>
    <path fill="${COHORT_ICON_ACCENT}" d="${COHORT_MARK_DOT}"/>
  </g>
</svg>`;
}

export const COHORT_ICON_VERSION = markVersion(
  cohortIconSvg(512) + cohortIconSvg(512, { fullBleed: true, maskable: true }),
);
