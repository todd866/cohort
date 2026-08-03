'use client';

import Link from 'next/link';
import { Accordion } from '@/components/ui/Accordion';
import { ExamDatesEditor } from '../profile-exam-dates';
import { PersonalDocumentsDestination } from './PersonalDocumentsDestination';
import {
  AppearanceSection,
  EmailAliasesSection,
  InstitutionModulesSection,
} from '../profile-settings-sections';

export interface SettingsRotation {
  id: string;
  shortName: string;
  examDate: string;
}

export default function ProfileSettingsClient({
  primaryEmail,
  initialJurisdiction,
  rotations,
}: {
  primaryEmail: string | null;
  initialJurisdiction: string | null;
  rotations: SettingsRotation[];
}) {
  return (
    <>
      <Accordion title="Exam dates" subtitle="Personal deadlines">
        <ExamDatesEditor rotations={rotations} />
      </Accordion>

      <Accordion title="Appearance" subtitle="Theme">
        <AppearanceSection />
      </Accordion>

      <Accordion title="Institution & content" subtitle="Modules and guidelines">
        <InstitutionModulesSection initialJurisdiction={initialJurisdiction} />
      </Accordion>

      <Accordion title="Email addresses" subtitle="Sign-in aliases">
        <EmailAliasesSection primaryEmail={primaryEmail} />
      </Accordion>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <PersonalDocumentsDestination />
        <SecondaryDestination
          href="/profile/support"
          title="Feedback"
          description="Send a problem or suggestion"
        />
      </div>
    </>
  );
}

function SecondaryDestination({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-16 flex-col justify-center rounded-xl border border-[var(--md-outline-variant)] px-4 py-3 text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)]"
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-0.5 block text-xs text-[var(--md-on-surface-variant)]">
        {description}
      </span>
    </Link>
  );
}
