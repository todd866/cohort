import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '@/lib/prisma';
import { putPrivateR2Object } from '@/lib/flags/image-storage.server';
import { FLAG_IMAGE_MAX_BYTES, FLAG_IMAGE_MAX_PIXELS, FLAG_IMAGE_DRAFT_DAYS } from './image-contract';

export async function normalizeFlagImage(base64: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error('Invalid image');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > FLAG_IMAGE_MAX_BYTES) throw new Error('Image must be 2 MB or smaller');
  const pipeline = sharp(bytes, { limitInputPixels: FLAG_IMAGE_MAX_PIXELS, failOn: 'warning', animated: false });
  const meta = await pipeline.metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1) throw new Error('Choose a PNG, JPEG or WebP image');
  if (!meta.width || !meta.height || meta.width * meta.height > FLAG_IMAGE_MAX_PIXELS) throw new Error('Image dimensions are too large');
  // Decoding and re-encoding removes EXIF/GPS, ancillary payloads and filenames.
  const data = await pipeline.rotate().webp({ quality: 88 }).toBuffer();
  if (data.length > FLAG_IMAGE_MAX_BYTES) throw new Error('Image must be 2 MB or smaller');
  return { data, sha256: createHash('sha256').update(data).digest('hex') };
}

export async function prepareFlagImage(userId: string, targetType: string, targetId: string, uploadId: string, base64: string) {
  const { data, sha256 } = await normalizeFlagImage(base64);
  const id = 'flag-image-' + createHash('sha256').update(`${userId}:${uploadId}`).digest('hex');
  const now = new Date();
  // Server PUT has no browser grant, but allow an in-flight PUT to finish before
  // account deletion/cleanup removes it. Same row lock as document allocation.
  const uploadUrlExpiresAt = new Date(now.getTime() + 10 * 60_000);
  const doc = await prisma.$transaction(async tx => {
    const users = await tx.$queryRawUnsafe<Array<{ id: string; privacyDeletionRequestedAt: Date | null }>>(
      'SELECT "id", "privacyDeletionRequestedAt" FROM "User" WHERE "id" = $1 FOR UPDATE', userId,
    );
    if (users.length !== 1 || users[0].privacyDeletionRequestedAt) throw new Error('Account unavailable');
    const existing = await tx.userDocument.findUnique({ where: { id } });
    if (existing) {
      const m = existing.metadata as Record<string, unknown> | null;
      if (existing.userId !== userId || m?.sha256 !== sha256 || m?.targetType !== targetType || m?.targetId !== targetId || existing.status === 'pending-deletion' || (!existing.flagIssueId && (!existing.deleteAfter || existing.deleteAfter <= now))) throw new Error('Image upload changed; choose it again');
      if (existing.status !== 'quarantined') throw new Error('Image upload is still settling; try again shortly');
      return existing;
    }
    if (await tx.userDocument.count({ where: { userId, purpose: 'flag-image', flagIssueId: null, status: { in: ['pending', 'quarantined'] }, deleteAfter: { gt: now } } }) >= 10) throw new Error('Too many pending images; remove an earlier image first');
    return tx.userDocument.create({ data: {
      id, userId, purpose: 'flag-image', filename: 'feedback.webp', mimeType: 'image/webp', sizeBytes: data.length,
      r2Key: `user-docs/quarantine/${userId}/flags/${id}.webp`, status: 'pending', uploadUrlExpiresAt,
      deleteAfter: new Date(now.getTime() + 60 * 60_000),
      metadata: { quarantined: true, quarantineReason: 'untrusted-feedback-image', targetType, targetId, sha256 },
    } });
  });
  if (doc.status === 'quarantined') return doc.id;
  try {
    await putPrivateR2Object(doc.r2Key, data, 'image/webp');
    const completed = await prisma.userDocument.updateMany({ where: { id, userId, status: 'pending' }, data: {
      status: 'quarantined', deleteAfter: new Date(Date.now() + FLAG_IMAGE_DRAFT_DAYS * 86_400_000),
    } });
    if (completed.count !== 1) throw new Error('Image upload was cancelled');
  } catch {
    await prisma.userDocument.updateMany({ where: { id, userId, flagIssueId: null }, data: { status: 'pending-deletion', deletionRequestedAt: new Date(), deleteAfter: new Date(uploadUrlExpiresAt.getTime() + 60_000) } });
    throw new Error('Image upload failed; remove and choose it again to retry');
  }
  return id;
}
