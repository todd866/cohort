import type { Prisma } from '@prisma/client';
import { parseCheckIns, type CheckInState } from './policy';

/** Caller holds both User row locks during the existing guest-progress claim. */
export async function claimGuestCheckIns(tx: Prisma.TransactionClient, userId: string, guestProfile: unknown) {
  const guest = parseCheckIns(guestProfile);
  if (!guest.shown.length && !Object.keys(guest.answers).length && !guest.discoverySkipped) return;
  const rows = await tx.$queryRaw<Array<{ feedProfile: unknown }>>`
    SELECT "feedProfile" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `;
  if (!rows.length) return;
  const account = parseCheckIns(rows[0].feedProfile);
  const shown = new Map([...guest.shown, ...account.shown].map(claim => [claim.id, claim]));
  const state: CheckInState = {
    shown: [...shown.values()].sort((a, b) => a.at - b.at),
    answers: { ...guest.answers, ...account.answers },
    ...(guest.discoverySkipped || account.discoverySkipped ? { discoverySkipped: true } : {}),
  };
  await tx.$executeRaw`
    UPDATE "User" SET "feedProfile" = jsonb_set(
      CASE WHEN jsonb_typeof("feedProfile") = 'object' THEN "feedProfile" ELSE '{}'::jsonb END,
      '{checkIns}', ${JSON.stringify(state)}::jsonb, true
    ) WHERE "id" = ${userId}
  `;
}
