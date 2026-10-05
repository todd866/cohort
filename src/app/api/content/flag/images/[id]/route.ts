import { NextResponse } from 'next/server';
import { requireAuthOrExistingGuest, requireAuth } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { getPrivateR2Object } from '@/lib/flags/image-storage.server';
import { isSameOriginImageRequest } from '@/lib/flags/image-contract';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
async function owned(id: string) {
  const auth = await requireAuthOrExistingGuest();
  if (auth.response) { for (const [key, value] of Object.entries(headers)) auth.response.headers.set(key, value); return { response: auth.response }; }
  const limit = await checkUserRateLimit(auth.userId, 'flag-image-read', 60, 60_000);
  if (!limit.ok) return { response: NextResponse.json({ error: 'Try again shortly' }, { status: 429, headers }) };
  let admin = false;
  if (!auth.isGuest) {
    const signed = await requireAuth();
    if (signed.response || signed.userId !== auth.userId) return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401, headers }) };
    admin = signed.isAdmin === true;
  }
  const doc = await prisma.userDocument.findFirst({ where: { id, purpose: 'flag-image', status: 'quarantined', user: { privacyDeletionRequestedAt: null }, ...(admin ? {} : { userId: auth.userId }) } });
  if (!doc || (!doc.flagIssueId && (!doc.deleteAfter || doc.deleteAfter <= new Date()))) return { response: NextResponse.json({ error: 'Image not found' }, { status: 404, headers }) };
  return { doc, userId: auth.userId, admin };
}
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await owned((await params).id);
  if (result.response) return result.response;
  try {
    return new NextResponse(new Uint8Array(await getPrivateR2Object(result.doc.r2Key)).buffer, { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Disposition': 'inline; filename="feedback.webp"', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch { return NextResponse.json({ error: 'Image unavailable' }, { status: 502, headers }); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginImageRequest(request)) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403, headers });
  const result = await owned((await params).id);
  if (result.response) return result.response;
  // Only an uploader may discard their own draft. Submitted reports belong to
  // moderation; deletion/account erasure uses the existing document lifecycle.
  if (result.doc.userId !== result.userId || result.doc.flagIssueId) return NextResponse.json({ error: 'Image cannot be removed' }, { status: 409, headers });
  const now = new Date();
  await prisma.userDocument.updateMany({ where: { id: result.doc.id, userId: result.userId, flagIssueId: null, status: 'quarantined' }, data: { status: 'pending-deletion', deletionRequestedAt: now, deleteAfter: new Date(Math.max(now.getTime(), result.doc.uploadUrlExpiresAt.getTime() + 60_000)) } });
  return NextResponse.json({ ok: true }, { headers });
}
