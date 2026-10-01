import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms - MD3',
  description: 'Terms requirements for operators of the MD3 source distribution.',
};

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-[var(--md-primary)] hover:underline">
        &larr; Back to home
      </Link>
      <h1 className="mt-8 text-4xl font-bold text-[var(--md-on-surface)]">
        Terms notice for operators
      </h1>
      <div className="mt-8 space-y-5 text-[var(--md-on-surface-variant)]">
        <p>
          This source artifact does not define terms for any hosted service. Before onboarding
          learners, each operator must publish terms that identify the service operator and
          accurately describe eligibility, acceptable use, support, privacy, and applicable law.
        </p>
        <p>
          Reuse of the software and educational materials is governed by the checked-in
          <code className="mx-1">LICENSE</code>, <code className="mx-1">LICENSE-CONTENT.md</code>,
          and source-level attribution records. A hosted service&apos;s terms must not contradict
          those reuse rights.
        </p>
        <p>
          MD3 is educational software, not medical advice, diagnosis, or treatment. Learners and
          operators must verify medical information against current authoritative sources.
        </p>
        <p>
          See the <Link href="/privacy" className="text-[var(--md-primary)] hover:underline">
            operator privacy notice
          </Link> for minimum deployment requirements.
        </p>
      </div>
    </main>
  );
}
