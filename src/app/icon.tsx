import { ImageResponse } from 'next/og';
import { headers } from 'next/headers';
import { detectInstitutionFromHostname } from '@/lib/institution';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';
export const runtime = 'edge';

export default async function Icon() {
  const headersList = await headers();
  const host = headersList.get('host') ?? '';
  const institution = detectInstitutionFromHostname(host);
  const isCohort = institution === 'usmle';

  const letter = isCohort ? 'C' : 'M';
  const bg = isCohort ? '#6366f1' : '#3b82f6';

  return new ImageResponse(
    (
      <div
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '8px',
          background: bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ color: 'white', fontSize: '20px', fontWeight: 700, fontFamily: 'system-ui' }}>
          {letter}
        </span>
      </div>
    ),
    { ...size }
  );
}
