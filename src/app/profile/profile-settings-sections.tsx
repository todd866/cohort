'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import {
  useInstitution,
  INSTITUTIONS,
  UNIVERSAL_MODULES,
  type Institution,
} from '@/hooks/useInstitution';

// ── AppearanceSection ─────────────────────────────────────────

export function AppearanceSection() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const themeOptions = [
    {
      id: 'system',
      label: 'System',
      description: `Matches device (${resolvedTheme})`,
    },
    { id: 'light', label: 'Light', description: 'Always light mode' },
    { id: 'dark', label: 'Dark', description: 'Always dark mode' },
  ] as const;

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2 text-[var(--md-on-surface)]">
        Appearance
      </h3>
      <div className="space-y-2">
        {themeOptions.map((option) => {
          const isSelected = theme === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setTheme(option.id)}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                isSelected
                  ? 'bg-[var(--md-primary-container)] border-[var(--md-primary)] text-[var(--md-on-primary-container)]'
                  : 'bg-[var(--md-surface)] border-[var(--md-outline-variant)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'
              }`}
            >
              <div className="text-sm font-medium">{option.label}</div>
              <div
                className={`text-xs ${
                  isSelected
                    ? 'text-[var(--md-on-primary-container)]/70'
                    : 'text-[var(--md-on-surface-variant)]'
                }`}
              >
                {option.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── InstitutionModulesSection ─────────────────────────────────

const CC_SUBROTATIONS = [
  { id: 'icu', name: 'ICU', description: 'Intensive Care Unit' },
  { id: 'anaesthetics', name: 'Anaesthetics', description: 'Operating theatre & sedation' },
  { id: 'em', name: 'Emergency', description: 'Emergency Department' },
] as const;

const JURISDICTION_OPTIONS = [
  { id: '', label: 'Auto (based on institution)', description: 'Inferred from your institution' },
  { id: 'nsw', label: 'New South Wales', description: 'NSW Health guidelines' },
  { id: 'wa', label: 'Western Australia', description: 'WA Health guidelines' },
  { id: 'national', label: 'National (All)', description: 'See all content across jurisdictions' },
] as const;

function JurisdictionSelector({
  initialJurisdiction,
}: {
  initialJurisdiction: string | null;
}) {
  const [jurisdiction, setJurisdiction] = useState<string | null>(initialJurisdiction);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const handleChange = async (value: string) => {
    const previous = jurisdiction;
    setSaving(true);
    setSaveError(false);
    const newValue = value || null;
    setJurisdiction(newValue);

    try {
      const response = await fetch('/api/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jurisdiction: newValue }),
      });
      if (!response.ok) throw new Error(`jurisdiction save failed: ${response.status}`);
    } catch {
      setJurisdiction(previous);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label
        htmlFor="profile-jurisdiction"
        className="block text-sm font-medium text-[var(--md-on-surface-variant)] mb-2"
      >
        Guidelines Jurisdiction
      </label>
      <p className="text-xs text-[var(--md-on-surface-variant)] mb-2">
        Which state&apos;s health guidelines should we show?
      </p>
      <select
        id="profile-jurisdiction"
        value={jurisdiction || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="w-full px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-[var(--md-on-surface)] disabled:opacity-50"
      >
        {JURISDICTION_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label} — {option.description}
          </option>
        ))}
      </select>
      {saveError ? (
        <p role="alert" className="mt-2 text-xs text-[var(--md-error)]">
          Could not save the guideline jurisdiction.
        </p>
      ) : null}
    </div>
  );
}

function CCSubrotationSelector() {
  const [subrotation, setSubrotation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/user/cc-subrotation')
      .then((res) => res.json())
      .then((data) => {
        setSubrotation(data.ccSubrotation || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleChange = async (value: string) => {
    setSaving(true);
    setSubrotation(value || null);

    try {
      await fetch('/api/user/cc-subrotation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ccSubrotation: value || null }),
      });
    } catch (err) {
      console.error('Failed to save CC sub-rotation:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-[var(--md-on-surface-variant)]">Loading...</div>;
  }

  return (
    <div>
      <label className="block text-sm font-medium text-[var(--md-on-surface-variant)] mb-2">
        Current CC Placement
      </label>
      <select
        value={subrotation || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="w-full px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-[var(--md-on-surface)] disabled:opacity-50"
      >
        <option value="">Not set / Not on CC</option>
        {CC_SUBROTATIONS.map((sub) => (
          <option key={sub.id} value={sub.id}>
            {sub.name} — {sub.description}
          </option>
        ))}
      </select>
    </div>
  );
}

export function InstitutionModulesSection({
  initialJurisdiction = null,
}: {
  initialJurisdiction?: string | null;
}) {
  const {
    institution,
    enabledModules,
    setInstitution,
    toggleModule,
    loading: institutionLoading,
  } = useInstitution();

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3 text-[var(--md-on-surface)]">
        Institution & Modules
      </h3>

      {institutionLoading ? (
        <div className="text-[var(--md-on-surface-variant)]">Loading...</div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--md-on-surface-variant)] mb-2">
              Primary Institution
            </label>
            <select
              value={institution || ''}
              onChange={(e) => {
                const value = e.target.value;
                if (!value) return;
                setInstitution(value as Institution);
              }}
              className="w-full px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-[var(--md-on-surface)]"
            >
              <option value="">Select institution...</option>
              {Object.entries(INSTITUTIONS).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.name}
                </option>
              ))}
            </select>
          </div>

          <JurisdictionSelector initialJurisdiction={initialJurisdiction} />

          {institution === 'usyd' && <CCSubrotationSelector />}

          <div>
            <h4 className="text-sm font-medium text-[var(--md-on-surface)] mb-1">
              Universal Content
            </h4>
            <p className="text-xs text-[var(--md-on-surface-variant)] mb-3">
              Mixed into study sessions (~20%). Disable for institution-only content.
            </p>
            <div className="space-y-2">
              {UNIVERSAL_MODULES.map((module) => (
                <label
                  key={module.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-[var(--md-surface)] cursor-pointer hover:bg-[var(--md-surface-container-high)] transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={enabledModules.includes(module.id)}
                    onChange={(e) => toggleModule(module.id, e.target.checked)}
                    className="w-4 h-4 rounded accent-[var(--md-primary)]"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--md-on-surface)]">
                      {module.name}
                    </div>
                    <div className="text-xs text-[var(--md-on-surface-variant)]">
                      {module.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── EmailAliasesSection ───────────────────────────────────────

interface EmailAlias {
  id: string;
  email: string;
  verified: boolean;
  verifiedAt: string | null;
  label: string | null;
  createdAt: string;
}

export function EmailAliasesSection({ primaryEmail }: { primaryEmail: string | null }) {
  const [aliases, setAliases] = useState<EmailAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchAliases();
  }, []);

  const fetchAliases = async () => {
    try {
      const res = await fetch('/api/user/email-aliases');
      const data = await res.json();
      setAliases(data.aliases || []);
    } catch {
      console.error('Failed to fetch email aliases');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;

    setAdding(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/user/email-aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          label: newLabel.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to add email');
      }

      setSuccess(data.message || 'Verification email sent');
      setNewEmail('');
      setNewLabel('');
      await fetchAliases();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add email');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (aliasId: string) => {
    if (!confirm('Remove this email alias?')) return;

    try {
      const res = await fetch(`/api/user/email-aliases?id=${aliasId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to remove email');
      }

      await fetchAliases();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove email');
    }
  };

  if (loading) {
    return <div className="text-[var(--md-on-surface-variant)]">Loading...</div>;
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2 text-[var(--md-on-surface)]">
        Email Addresses
      </h3>
      <p className="text-xs text-[var(--md-on-surface-variant)] mb-3">
        Add alternative emails to sign in with any of them.
      </p>

      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--md-surface)]">
          <div className="flex-1">
            <div className="text-sm font-medium text-[var(--md-on-surface)]">
              {primaryEmail}
            </div>
          </div>
          <span className="px-2 py-0.5 rounded text-xs bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
            Primary
          </span>
        </div>

        {aliases.map((alias) => (
          <div
            key={alias.id}
            className="flex items-center gap-3 p-3 rounded-lg bg-[var(--md-surface)]"
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-[var(--md-on-surface)]">
                {alias.email}
              </div>
              {alias.label && (
                <div className="text-xs text-[var(--md-on-surface-variant)]">
                  {alias.label}
                </div>
              )}
            </div>
            {alias.verified ? (
              <span className="px-2 py-0.5 rounded text-xs bg-[var(--md-tertiary-container)] text-[var(--md-on-tertiary-container)]">
                Verified
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded text-xs bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]">
                Pending
              </span>
            )}
            <button
              onClick={() => handleDelete(alias.id)}
              className="p-1 rounded hover:bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]"
              title="Remove alias"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="Add another email..."
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-[var(--md-on-surface)] text-sm"
        />
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label"
          className="w-24 px-3 py-2 rounded-lg bg-[var(--md-surface)] border border-[var(--md-outline)] text-[var(--md-on-surface)] text-sm"
        />
        <button
          type="submit"
          disabled={adding || !newEmail.trim()}
          className="px-4 py-2 rounded-lg bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] text-sm font-medium disabled:opacity-50"
        >
          {adding ? '...' : 'Add'}
        </button>
      </form>

      {error && <div className="text-sm text-[var(--md-error)] mt-2">{error}</div>}
      {success && <div className="text-sm text-[var(--md-primary)] mt-2">{success}</div>}
    </div>
  );
}
