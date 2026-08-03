import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy - MD3',
  description: 'Privacy requirements for operators of the MD3 source distribution.',
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-[var(--md-primary)] hover:underline">
        &larr; Back to home
      </Link>
      <h1 className="mt-8 text-4xl font-bold text-[var(--md-on-surface)]">
        Privacy notice for operators
      </h1>
      <div className="mt-8 space-y-5 text-[var(--md-on-surface-variant)]">
        <p>
          This source artifact does not publish a privacy policy for any hosted service.
          Each operator is responsible for documenting the data, cookies, processors,
          retention periods, security practices, and contact route used by their deployment.
        </p>
        <p>
          The artifact itself provides no self-service account-data export or account deletion.
          Before onboarding learners, an operator must implement and publish a verified process
          for access, correction, export, deletion, and incomplete-cleanup handling that matches
          the deployed system and applicable law.
        </p>
        <p>
          Do not submit patient-identifiable information or clinical records. MD3 is educational
          software, not a clinical-record system or medical advice service.
        </p>
        <p>
          See the <Link href="/terms" className="text-[var(--md-primary)] hover:underline">
            operator terms notice
          </Link> before offering a hosted service.
        </p>
      </div>
    </main>
  );
}
