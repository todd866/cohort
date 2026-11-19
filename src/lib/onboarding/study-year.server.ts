import 'server-only';

import type { Prisma } from '@prisma/client';
import type { StudyYear } from './study-year';

/**
 * Record the first-run year in `User.feedProfile.onboardingYear`. No schema
 * change: feedProfile is the existing profile JSON. A targeted jsonb_set keeps
 * every other key (check-ins, explicit answers) that a concurrent writer owns.
 */
export async function stampOnboardingYear(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  userId: string,
  year: StudyYear,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "User" SET "feedProfile" = jsonb_set(
      CASE WHEN jsonb_typeof("feedProfile") = 'object' THEN "feedProfile" ELSE '{}'::jsonb END,
      '{onboardingYear}', ${JSON.stringify(year)}::jsonb, true
    ) WHERE "id" = ${userId}
  `;
}
