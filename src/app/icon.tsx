import { ImageResponse } from 'next/og';
import { headers } from 'next/headers';
import { detectInstitutionFromHostname } from '@/lib/institution';
import { md3IconSvg } from '@/lib/brand/md3-mark';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';
export const runtime = 'edge';

export default async function Icon() {
  const headersList = await headers();
  const host = headersList.get('host') ?? '';
  const institution = detectInstitutionFromHostname(host);
  const isCohort = institution === 'usmle';

  if (!isCohort) {
    return new ImageResponse(
      <img width={32} height={32} src={`data:image/svg+xml,${encodeURIComponent(md3IconSvg(32))}`} alt="" />,
      { ...size },
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '8px',
          background: '#6366f1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ color: 'white', fontSize: '20px', fontWeight: 700, fontFamily: 'system-ui' }}>
          C
        </span>
      </div>
    ),
    { ...size }
  );
}
