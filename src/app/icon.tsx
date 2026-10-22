import { ImageResponse } from 'next/og';
import { headers } from 'next/headers';
import { detectInstitutionFromHostname } from '@/lib/institution';
import { md3IconSvg } from '@/lib/brand/md3-mark';
import { cohortIconSvg } from '@/lib/brand/cohort-mark';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';
export const runtime = 'edge';

export default async function Icon() {
  const headersList = await headers();
  const host = headersList.get('host') ?? '';
  const institution = detectInstitutionFromHostname(host);
  const isCohort = institution === 'usmle';

  const svg = isCohort ? cohortIconSvg(32) : md3IconSvg(32);
  return new ImageResponse(
    <img width={32} height={32} src={`data:image/svg+xml,${encodeURIComponent(svg)}`} alt="" />,
    { ...size },
  );
}
