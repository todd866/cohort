import { headers } from 'next/headers';
import { buildWebManifest } from '@/lib/offline/manifest';

/**
 * Served as a route handler rather than Next's static `app/manifest.ts` because
 * one deployment answers for two brands (md3.info and cohort.md) and an
 * installed app keeps the name and icon it was installed with.
 */
export async function GET() {
  const headersList = await headers();
  const host = headersList.get('host') ?? '';

  return Response.json(buildWebManifest(host), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
