import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireAuth } from '@/lib/api-utils';

const ccSubrotationPatchSchema = z.object({
  ccSubrotation: z.enum(['icu', 'anaesthetics', 'em']).nullable(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { ccSubrotation: true },
    });

    return NextResponse.json({ ccSubrotation: user?.ccSubrotation || null });
  } catch (error) {
    logger.error('CC subrotation fetch failed', { error: String(error) });
    return NextResponse.json({ error: 'Failed to load subrotation' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = ccSubrotationPatchSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid value' }, { status: 400 });
    }
    const { ccSubrotation } = parseResult.data;

    await prisma.user.update({
      where: { id: userId },
      data: { ccSubrotation },
    });

    return NextResponse.json({ success: true, ccSubrotation });
  } catch (error) {
    logger.error('CC subrotation update failed', { error: String(error) });
    return NextResponse.json({ error: 'Failed to update subrotation' }, { status: 500 });
  }
}
