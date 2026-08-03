import {
  detectInstitutionFromHostname,
  SUPPORTS_PERSONAL_BRIEF,
} from '@/lib/institution';

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

export interface ManifestShortcut {
  name: string;
  url: string;
}

export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  orientation: 'portrait';
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
  shortcuts?: ManifestShortcut[];
}

/**
 * The web app manifest, per host.
 *
 * md3 serves two brands off one deployment (md3.info and cohort.md), and an
 * installed app keeps whatever name and icon it was installed with — so this has
 * to be host-aware, which rules out Next's static `app/manifest.ts`. It is served
 * from a route handler instead.
 */
export function buildWebManifest(host: string): WebManifest {
  const isCohort = detectInstitutionFromHostname(host) === 'usmle';
  const slug = isCohort ? 'cohort' : 'md3';

  const icons: ManifestIcon[] = [
    { src: `/icons/${slug}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/icons/${slug}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: `/icons/${slug}-maskable-512.png`,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ];

  return {
    name: isCohort ? 'cohort.md' : 'MD3',
    short_name: isCohort ? 'cohort.md' : 'MD3',
    description: isCohort
      ? 'Free USMLE Step 1 prep — spaced repetition and clinical vignettes'
      : 'Clinical learning platform for medical students',
    // Cohort's root feed is intentionally generic; start its installed app at
    // the Step 1 product surface so a fresh learner cannot land on an empty
    // rotation queue.
    start_url: isCohort ? '/usmle/step1' : '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: isCohort ? '#6366f1' : '#3b82f6',
    icons,
    // The brief is a single-user surface that only exists on the md3 host.
    // Points at the real route, not the /brief redirect that replaced it: an
    // installed shortcut should not spend a hop, and offline a redirect cannot
    // be followed at all.
    ...(isCohort || !SUPPORTS_PERSONAL_BRIEF
      ? {}
      : { shortcuts: [{ name: 'Brief', url: '/brief' }] }),
  };
}
