import 'server-only';

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isCohortHostname } from '@/lib/institution';

/**
 * Withhold private USyd rotation content from the public Cohort host.
 *
 * THIS REPLACES `adminGate()` ON THE ROTATION TREES, and the distinction is the
 * bug it fixes. The gate arrived with the Cohort split (6a7d1f265, "public
 * USMLE Step 1 on Cohort") and its intent was DISTRIBUTION — private USyd
 * material must not appear on cohort.md. It was implemented as IDENTITY —
 * admins only — which also locked out every genuine md3.info learner.
 *
 * The result: /cah, /critical-care, /paam, /pwh and every week page under them
 * rendered "Page not found" for everybody except the owner. The Content tab
 * listed seven weeks and every one of them was a dead link, for months, for all
 * users. Reported 2026-09-14 by a learner who assumed it was her account.
 *
 * Anonymous access is deliberately allowed here, because /content — the index
 * that links to these pages — is already public and already lists them. Making
 * the leaves stricter than the index is what produced a list of dead links.
 * These are lecture-derived teaching pages, not personal data; the private
 * surfaces that DO need an identity check (admin tooling, /exams, personal
 * decks) keep their own gates and are untouched by this.
 */
export async function privateContentGate(): Promise<void> {
  const host = (await headers()).get('host') ?? '';
  if (isCohortHostname(host)) {
    notFound();
  }
}
