import checkedInReleaseManifest from '../../../open-content/usmle/step1/release-v1.json';
import { parseOpenUsmleReleaseManifest } from './public-release';

/** Build-bundled release authority shared by delivery and write boundaries. */
export const CHECKED_IN_OPEN_USMLE_RELEASE = parseOpenUsmleReleaseManifest(
  checkedInReleaseManifest,
);

export const CHECKED_IN_OPEN_USMLE_RELEASE_IDS = new Set(
  CHECKED_IN_OPEN_USMLE_RELEASE.questionIds,
);
