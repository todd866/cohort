import type { ImageSidecar, Modality } from './types';

const GENERIC_ALT_BY_MODALITY: Record<Modality, string> = {
  photo: 'clinical photograph',
  cxr: 'chest X-ray',
  ct: 'CT image',
  mri: 'MRI image',
  ecg: 'ECG',
  us: 'ultrasound image',
  otoscopy: 'otoscopic view',
  fundoscopy: 'fundoscopic image',
  derm: 'clinical photograph',
  histology: 'histology slide',
  other: 'clinical image',
};

export function imageAltFor(sidecar: ImageSidecar | undefined, revealed: boolean): string {
  if (!sidecar) return 'Question figure';
  if (sidecar.class === 'diagram') return sidecar.caption;
  if (sidecar.class === 'decorative') return 'clinical image';
  if (sidecar.class === 'lake-reference') return sidecar.topic || 'clinical image';
  const generic = GENERIC_ALT_BY_MODALITY[sidecar.modality] ?? 'clinical image';
  if (revealed && sidecar.altPolicy !== 'generic') {
    return `${generic}: ${sidecar.keyFindings.join('; ')}`;
  }
  return generic;
}
