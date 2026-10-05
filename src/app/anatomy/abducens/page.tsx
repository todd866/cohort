import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { isCohortHostname } from '@/lib/institution';

export const metadata: Metadata = {
  title: 'Abducens nerve: movement and meaning — cohort.md',
  description: 'How cranial nerve VI moves the eye, and what happens when it is injured.',
};

export default async function AbducensGuidePage() {
  if (!isCohortHostname((await headers()).get('host') ?? '')) notFound();
  return (
    <section className="mx-auto max-w-4xl px-4 py-5 sm:px-6">
      <Link href="/anatomy" className="text-sm text-[var(--md-primary)]">← Anatomy practice</Link>
      <div className="mt-4 grid gap-5 md:grid-cols-2 md:items-center">
        <figure className="m-0">
          <Image src="/api/anatomy/abducens" alt="Right eye viewed obliquely from above. The abducens nerve approaches the globe-facing side of lateral rectus; the optic nerve leaves the back of the globe." width={1254} height={1254} unoptimized priority className="mx-auto h-auto max-h-[58svh] w-auto max-w-full" />
        </figure>
        <div>
          <h1 className="text-2xl font-semibold">A nerve that moves the eye outward</h1>
          <p className="mt-4 leading-relaxed"><strong>CN VI → lateral rectus → abduction.</strong> The abducens nerve supplies the muscle that turns the eye away from the nose.</p>
          <p className="mt-3 leading-relaxed">If the right nerve is damaged, the right eye cannot abduct normally. Horizontal double vision is worse when looking right, where the weak muscle is needed most.</p>
          <p className="mt-3 leading-relaxed">The optic nerve carries visual information. It is a separate structure from the motor nerve that moves the eye.</p>
          <details className="mt-5 text-sm text-[var(--md-on-surface-variant)]">
            <summary className="cursor-pointer">Sources and illustration</summary>
            <p className="mt-2">This original drawing shows a local relationship, not the whole orbit. The nerve entry point is hidden; its intracranial course is not shown.</p>
            <p className="mt-2"><a className="underline" href="https://pmc.ncbi.nlm.nih.gov/articles/PMC11089250/">Anatomical study</a> · <a className="underline" href="https://www.ncbi.nlm.nih.gov/books/NBK482177/">Abducens palsy</a></p>
            <p className="mt-2">Original AI-assisted illustration and editable labels: MD3 contributors, MIT licence. Source and independent pixel reviews; no clinician signoff.</p>
            <a className="mt-2 inline-block underline" href="/api/anatomy/abducens" download>Download illustration</a>
          </details>
        </div>
      </div>
    </section>
  );
}
