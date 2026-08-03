'use client';

import { useState } from 'react';
import {
  type EditForm,
  STUDYING_OPTIONS,
  YEAR_OPTIONS,
} from './profile-sections';
import type { ProfileIdentity } from './profile-identity';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

export type { ProfileIdentity } from './profile-identity';

function editFormFor(profile: ProfileIdentity): EditForm {
  return {
    name: profile.name || '',
    studyGoal: profile.studyGoal ?? 20,
    examDates: {},
    studying: profile.feedProfileExplicit.studying || '',
    year: profile.feedProfileExplicit.year || '',
    school: profile.feedProfileExplicit.school || '',
  };
}

export default function ProfilePageClient({
  initialProfile,
}: {
  initialProfile: ProfileIdentity;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(() => editFormFor(initialProfile));

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);

    const savedName = editForm.name.trim();
    const feedProfileExplicit = {
      studying: editForm.studying || undefined,
      year: editForm.year || undefined,
      school: editForm.school || undefined,
    };

    try {
      const patch = await fetchWithDeadline(
        '/api/user',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: savedName,
            studyGoal: editForm.studyGoal,
            feedProfileExplicit,
          }),
        },
        CLIENT_FETCH_DEADLINE_MS,
      );
      if (!patch.ok) throw new Error(`profile save failed: ${patch.status}`);

      setProfile((current) => ({
        ...current,
        name: savedName,
        studyGoal: editForm.studyGoal,
        feedProfileExplicit,
      }));
      setEditing(false);
    } catch {
      setSaveError('Could not save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Account details" className="mb-6">
      {!profile.name ? <h1 className="sr-only">Profile</h1> : null}
      <div className="flex items-center gap-4">
        {profile.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.image}
            alt=""
            className="h-16 w-16 flex-shrink-0 rounded-full"
          />
        ) : (
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full bg-[var(--md-primary-container)] text-xl font-bold text-[var(--md-on-primary-container)]">
            {(profile.name || profile.email || '?')[0].toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              type="text"
              id="profile-name"
              aria-label="Your name"
              autoComplete="name"
              value={editForm.name}
              onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
              placeholder="Your name"
              className="w-full rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container)] px-3 py-1 text-xl font-bold text-[var(--md-on-surface)]"
            />
          ) : profile.name ? (
            <h1 className="truncate text-xl font-bold text-[var(--md-on-surface)]">
              {profile.name}
            </h1>
          ) : null}
          <p
            className={`truncate text-sm text-[var(--md-on-surface${
              profile.name ? '-variant' : ''
            })]`}
          >
            {profile.email}
          </p>

          {!editing
            && (
              profile.feedProfileExplicit.studying
              || profile.feedProfileExplicit.year
              || profile.feedProfileExplicit.school
            ) ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {profile.feedProfileExplicit.studying ? (
                  <span className="rounded-full bg-[var(--md-primary-container)] px-2.5 py-0.5 text-xs text-[var(--md-on-primary-container)]">
                    {profile.feedProfileExplicit.studying}
                  </span>
                ) : null}
                {profile.feedProfileExplicit.year ? (
                  <span className="rounded-full bg-[var(--md-secondary-container)] px-2.5 py-0.5 text-xs text-[var(--md-on-secondary-container)]">
                    {profile.feedProfileExplicit.year}
                  </span>
                ) : null}
                {profile.feedProfileExplicit.school ? (
                  <span className="rounded-full bg-[var(--md-tertiary-container)] px-2.5 py-0.5 text-xs text-[var(--md-on-tertiary-container)]">
                    {profile.feedProfileExplicit.school}
                  </span>
                ) : null}
              </div>
            ) : null}
        </div>

        <div className="flex-shrink-0 self-start">
          {editing ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setSaveError(null);
                  setEditForm(editFormFor(profile));
                }}
                disabled={saving}
                className="rounded-lg border border-[var(--md-outline)] px-3 py-1.5 text-sm text-[var(--md-on-surface)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-[var(--md-primary)] px-3 py-1.5 text-sm text-[var(--md-on-primary)]"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-lg border border-[var(--md-outline)] px-3 py-1.5 text-sm text-[var(--md-on-surface-variant)]"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-4 space-y-3 sm:pl-20">
          {saveError ? (
            <p role="alert" className="text-sm text-[var(--md-error)]">
              {saveError}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="profile-studying"
                className="mb-1 block text-xs text-[var(--md-on-surface-variant)]"
              >
                Studying
              </label>
              <select
                id="profile-studying"
                value={editForm.studying}
                onChange={(event) => setEditForm({ ...editForm, studying: event.target.value })}
                className="w-full rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container)] px-3 py-2 text-sm text-[var(--md-on-surface)]"
              >
                <option value="">Not set</option>
                {STUDYING_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="profile-year"
                className="mb-1 block text-xs text-[var(--md-on-surface-variant)]"
              >
                Year
              </label>
              <select
                id="profile-year"
                value={editForm.year}
                onChange={(event) => setEditForm({ ...editForm, year: event.target.value })}
                className="w-full rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container)] px-3 py-2 text-sm text-[var(--md-on-surface)]"
              >
                <option value="">Not set</option>
                {YEAR_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="profile-school"
              className="mb-1 block text-xs text-[var(--md-on-surface-variant)]"
            >
              University / School
            </label>
            <input
              type="text"
              id="profile-school"
              autoComplete="organization"
              value={editForm.school}
              onChange={(event) => setEditForm({ ...editForm, school: event.target.value })}
              placeholder="e.g. your medical school"
              className="w-full rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container)] px-3 py-2 text-sm text-[var(--md-on-surface)]"
            />
          </div>

          <div>
            <label
              htmlFor="profile-study-goal"
              className="mb-1 block text-xs text-[var(--md-on-surface-variant)]"
            >
              Daily card goal
            </label>
            <input
              type="number"
              id="profile-study-goal"
              value={editForm.studyGoal}
              onChange={(event) => {
                setEditForm({ ...editForm, studyGoal: Number.parseInt(event.target.value, 10) });
              }}
              className="w-24 rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface-container)] px-3 py-2 text-sm text-[var(--md-on-surface)]"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
