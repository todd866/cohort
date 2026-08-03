export type Institution = 'usyd' | 'usyd-md1' | 'usyd-md2' | 'usmle' | 'other';

export interface InstitutionConfig {
  name: string;
  shortName: string;
  rotationPrefix: string;
  hasTrackSystem: boolean;
  years: number[];
  entryPath: string;
  description?: string;
}

export const INSTITUTIONS = {
  usmle: {
    name: 'USMLE Step 1',
    shortName: 'USMLE',
    rotationPrefix: 'usmle-',
    hasTrackSystem: false,
    years: [],
    entryPath: '/usmle',
    description: 'USMLE Step 1 prep',
  },
  other: {
    name: 'Other / Just Learning',
    shortName: 'Other',
    rotationPrefix: '',
    hasTrackSystem: false,
    years: [],
    entryPath: '/',
    description: 'Use the open learning engine without a course preset',
  },
} satisfies Partial<Record<Institution, InstitutionConfig>>;

export type SupportedInstitution = keyof typeof INSTITUTIONS;

export const SUPPORTS_PERSONAL_BRIEF = false;
export const SUPPORTS_PERSONAL_DOCUMENTS = false;
export const SUPPORTS_CLINICAL_EXAMS = false;

export function isSupportedInstitution(value: unknown): value is SupportedInstitution {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(INSTITUTIONS, value);
}

export interface UniversalModule {
  id: string;
  name: string;
  description: string;
  groupTypes: string[];
  contentRotations?: string[];
  maxIntervalDays?: number;
  defaultEnabled: boolean;
}

export const UNIVERSAL_MODULES: UniversalModule[] = [];
export const DEFAULT_ENABLED_MODULES: string[] = [];

export function getInstitutionConfig(institution: Institution): InstitutionConfig {
  return isSupportedInstitution(institution)
    ? INSTITUTIONS[institution]
    : INSTITUTIONS.other;
}

export function isRotationForInstitution(
  rotation: string,
  institution: Institution,
): boolean {
  if (!isSupportedInstitution(institution)) return false;
  const prefix = INSTITUTIONS[institution].rotationPrefix;
  return prefix ? rotation.startsWith(prefix) : institution === 'other';
}

export function detectInstitutionFromHostname(hostname: string): Institution | null {
  const host = hostname.toLowerCase().split(':')[0];
  return host === 'cohort.md' || host === 'www.cohort.md' ? 'usmle' : null;
}

export function detectInstitutionFromPath(path: string): Institution | null {
  return path === '/usmle' || path.startsWith('/usmle/') ? 'usmle' : null;
}

export function getEnabledGroupTypes(enabledModules: string[]): string[] {
  return UNIVERSAL_MODULES
    .filter((module) => enabledModules.includes(module.id))
    .flatMap((module) => module.groupTypes);
}

export const INSTITUTION_STORAGE_KEY = 'md3_institution';
export const MODULES_STORAGE_KEY = 'md3_enabled_modules';
