import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { OFFLINE_TELEMETRY_EVENT } from '@/lib/offline/telemetry';

/**
 * Offline self-report sink.
 *
 * Writes to LearningEvent under its own eventType rather than a new table, so
 * it inherits the privacy inventory, the export flow and account deletion.
 *
 * The body is NOT trusted. Only a fixed set of scalar fields is copied across,
 * each coerced and clamped, so a compromised or buggy client cannot write
 * arbitrary JSON — or content — into the durable log.
 */

export const dynamic = 'force-dynamic';

const NUMBERS = [
  'packItems',
  'packAgeMin',
  'packRotations',
  'figuresCached',
  'outboxSize',
  'storageUsedMb',
  'storageQuotaMb',
] as const;

const STRINGS = ['persistence', 'displayMode', 'engine', 'lastError'] as const;
const BOOLS = ['swRegistered', 'swControlling'] as const;

function clampNumber(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1_000_000, Math.round(v * 10) / 10));
}

function clampString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const src = body as Record<string, unknown>;
  const metadata: Record<string, number | string | boolean> = {};

  for (const k of NUMBERS) {
    const n = clampNumber(src[k]);
    if (n !== null) metadata[k] = n;
  }
  for (const k of STRINGS) {
    const s = clampString(src[k], k === 'lastError' ? 300 : 40);
    if (s !== null) metadata[k] = s;
  }
  for (const k of BOOLS) {
    if (typeof src[k] === 'boolean') metadata[k] = src[k] as boolean;
  }

  await prisma.learningEvent.create({
    data: {
      userId: session.user.id,
      eventType: OFFLINE_TELEMETRY_EVENT,
      sourceType: 'device',
      sourceId: 'offline',
      conceptIds: [],
      metadata,
    },
  });

  return NextResponse.json({ ok: true });
}
