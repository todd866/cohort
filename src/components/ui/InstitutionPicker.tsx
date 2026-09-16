'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  useInstitution,
  INSTITUTIONS,
  type Institution,
} from '@/hooks/useInstitution';
import { getInstitutionConfig } from '@/lib/institution';

/**
 * Banner shown to users who haven't set an institution yet.
 * Appears on the homepage to help route them to the right content.
 */
export function InstitutionPickerBanner() {
  const router = useRouter();
  const { institution, setInstitution, loading } = useInstitution();

  // Don't show if loading or already has institution
  if (loading || institution) return null;

  const handleSelect = async (inst: Institution) => {
    await setInstitution(inst);

    const entryPath = getInstitutionConfig(inst).entryPath;
    if (entryPath !== '/') router.push(entryPath);
  };

  return (
    <div className="space-y-6">
      {/* Distribution-supported study paths */}
      <div className="p-6 rounded-2xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
        <h2 className="text-lg font-semibold text-[var(--md-on-surface)] mb-4 text-center">
          What are you studying?
        </h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Object.entries(INSTITUTIONS).map(([key, config]) => (
            <button
              key={key}
              onClick={() => handleSelect(key as Institution)}
              className="p-4 rounded-xl bg-[var(--md-primary-container)] text-center hover:brightness-105 transition-all border-2 border-transparent hover:border-[var(--md-primary)]"
            >
              <div className="text-lg font-bold text-[var(--md-on-primary-container)]">
                {config.name}
              </div>
              <div className="text-xs text-[var(--md-on-primary-container)] opacity-70 mt-1">
                {config.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Sign in prompt */}
      <div className="p-4 rounded-xl bg-[var(--md-tertiary-container)] text-center">
        <p className="text-sm text-[var(--md-on-tertiary-container)] mb-2">
          Sign in to track your progress across devices
        </p>
        <Link
          href="/api/auth/signin"
          className="inline-block px-4 py-2 rounded-lg bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)] text-sm font-medium hover:brightness-110 transition-all"
        >
          Sign in with Google
        </Link>
      </div>
    </div>
  );
}

/**
 * Compact institution indicator for header/nav
 * Shows current institution with option to switch
 */
export function InstitutionBadge() {
  const { institution, institutionConfig } = useInstitution();

  if (!institution || !institutionConfig) return null;

  return (
    <span className="px-2 py-0.5 text-xs rounded-full bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]">
      {institutionConfig.shortName}
    </span>
  );
}

/**
 * Small link to change institution (for anonymous users who picked wrong)
 */
export function ChangeInstitutionLink() {
  const { institution, setInstitution, institutionConfig, isLoggedIn } = useInstitution();
  const [showPicker, setShowPicker] = useState(false);

  // If logged in, they should use Profile page instead
  // Also return null if no institution config (shouldn't happen)
  if (isLoggedIn || !institution || !institutionConfig) return null;

  if (showPicker) {
    return (
      <div className="p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-[var(--md-on-surface)]">
            Change institution
          </span>
          <button
            onClick={() => setShowPicker(false)}
            className="text-xs text-[var(--md-on-surface-variant)]"
          >
            Cancel
          </button>
        </div>
        <div className="space-y-2">
          {Object.entries(INSTITUTIONS).map(([key, config]) => (
            <button
              key={key}
              onClick={() => {
                setInstitution(key as Institution);
                setShowPicker(false);
                const entryPath = getInstitutionConfig(key as Institution).entryPath;
                if (entryPath !== window.location.pathname) window.location.href = entryPath;
              }}
              className={`w-full p-3 rounded-lg text-left text-sm transition-colors ${
                key === institution
                  ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]'
                  : 'bg-[var(--md-surface)] hover:bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)]'
              }`}
            >
              {config.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowPicker(true)}
      className="text-xs text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)] transition-colors"
    >
      {institutionConfig.shortName} • Change
    </button>
  );
}
