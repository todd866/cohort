'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { BLOCKS, TRACK_SCHEDULES, getCurrentBlockIndex, type TrackNumber } from '@/lib/rotation-context';

interface TrackPickerProps {
  /** Called when user selects a track */
  onSelect: (track: TrackNumber) => void;
  /** Optional: currently selected track (for highlighting) */
  selected?: TrackNumber | null;
  /** Show login nudge for anonymous users */
  showLoginNudge?: boolean;
}

// Get current rotation for each track based on block
function getCurrentRotationsForTracks(): Record<TrackNumber, string> {
  const blockIndex = getCurrentBlockIndex();
  return {
    1: TRACK_SCHEDULES[1].rotations[blockIndex],
    2: TRACK_SCHEDULES[2].rotations[blockIndex],
    3: TRACK_SCHEDULES[3].rotations[blockIndex],
    4: TRACK_SCHEDULES[4].rotations[blockIndex],
  };
}

// Get next exam date string
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _getNextExamForTrack(): string {
  const blockIndex = getCurrentBlockIndex();
  return BLOCKS[blockIndex]?.examStr || '';
}

export function TrackPicker({
  onSelect,
  selected,
  showLoginNudge = true,
}: TrackPickerProps) {
  const { status } = useSession();
  const [justSelected, setJustSelected] = useState<TrackNumber | null>(null);
  const isAnonymous = status === 'unauthenticated';
  const currentRotations = getCurrentRotationsForTracks();

  const handleSelect = (track: TrackNumber) => {
    setJustSelected(track);
    onSelect(track);
  };

  const blockIndex = getCurrentBlockIndex();
  const nextExam = BLOCKS[blockIndex]?.examStr || '';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-[var(--md-on-surface)]">
          Which stream are you?
        </h2>
        <p className="text-sm text-[var(--md-on-surface-variant)] mt-1">
          Year 3 rotation streams
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {([1, 2, 3, 4] as TrackNumber[]).map((track) => {
          const isSelected = selected === track || justSelected === track;
          const schedule = TRACK_SCHEDULES[track];
          return (
            <button
              key={track}
              onClick={() => handleSelect(track)}
              className={`p-4 rounded-xl border text-left transition-all ${
                isSelected
                  ? 'bg-[var(--md-primary-container)] border-[var(--md-primary)] ring-2 ring-[var(--md-primary)]/30'
                  : 'bg-[var(--md-surface-container)] border-[var(--md-outline-variant)] hover:border-[var(--md-outline)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold">S{track}</span>
                <span className="text-xs text-[var(--md-on-surface-variant)]">
                  Exam {nextExam}
                </span>
              </div>
              <p className="text-xs text-[var(--md-on-surface-variant)] mt-2">
                {schedule.description}
              </p>
              <p className="text-sm font-medium text-[var(--md-primary)] mt-2">
                Now: {currentRotations[track]}
              </p>
            </button>
          );
        })}
      </div>

      {showLoginNudge && isAnonymous && justSelected && (
        <LoginNudgeCard />
      )}
    </div>
  );
}

function LoginNudgeCard() {
  return (
    <div className="p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      <p className="text-sm text-[var(--md-on-surface)]">
        <Link
          href="/auth/signin"
          className="text-[var(--md-primary)] hover:underline font-medium"
        >
          Sign in
        </Link>
        {' '}to save your progress and sync across devices
      </p>
    </div>
  );
}

/**
 * Compact banner that appears at the top of pages when track is unknown
 */
export function TrackPickerBanner({
  onSelect,
}: {
  onSelect: (track: TrackNumber) => void;
}) {
  const { status } = useSession();
  const isAnonymous = status === 'unauthenticated';
  const currentRotations = getCurrentRotationsForTracks();

  return (
    <div className="mb-6 p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      <p className="text-sm font-medium text-[var(--md-on-surface)] mb-3">
        Which stream are you?
      </p>
      <div className="grid grid-cols-4 gap-2">
        {([1, 2, 3, 4] as TrackNumber[]).map((track) => (
          <button
            key={track}
            onClick={() => onSelect(track)}
            className="p-3 rounded-lg border bg-[var(--md-surface-container-high)] border-[var(--md-outline-variant)] hover:border-[var(--md-outline)] transition-all text-center"
          >
            <div className="font-bold">S{track}</div>
            <div className="text-xs text-[var(--md-on-surface-variant)] mt-1">
              {currentRotations[track]}
            </div>
          </button>
        ))}
      </div>
      {isAnonymous && (
        <p className="text-xs text-[var(--md-on-surface-variant)] mt-3">
          <Link
            href="/auth/signin"
            className="text-[var(--md-primary)] hover:underline"
          >
            Sign in
          </Link>
          {' '}to save your choice
        </p>
      )}
    </div>
  );
}

/**
 * Confirmation banner - shows when user has a track but hasn't confirmed it
 */
export function TrackConfirmBanner({
  currentTrack,
  onConfirm,
  onChangeTrack,
}: {
  currentTrack: TrackNumber;
  onConfirm: () => void;
  onChangeTrack: (track: TrackNumber) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const currentRotations = getCurrentRotationsForTracks();

  if (showPicker) {
    return (
      <div className="mb-6 p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
        <p className="text-sm font-medium text-[var(--md-on-surface)] mb-3">
          Select your stream:
        </p>
        <div className="grid grid-cols-4 gap-2">
          {([1, 2, 3, 4] as TrackNumber[]).map((track) => (
            <button
              key={track}
              onClick={() => onChangeTrack(track)}
              className={`p-3 rounded-lg border transition-all text-center ${
                track === currentTrack
                  ? 'bg-[var(--md-primary-container)] border-[var(--md-primary)]'
                  : 'bg-[var(--md-surface-container-high)] border-[var(--md-outline-variant)] hover:border-[var(--md-outline)]'
              }`}
            >
              <div className="font-bold">S{track}</div>
              <div className="text-xs text-[var(--md-on-surface-variant)] mt-1">
                {currentRotations[track]}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 rounded-xl bg-[var(--md-primary-container)] border border-[var(--md-primary)]/30">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[var(--md-on-primary-container)]">
            You&apos;re set to Stream {currentTrack} ({currentRotations[currentTrack]})
          </p>
          <p className="text-xs text-[var(--md-on-primary-container)]/70 mt-0.5">
            Is that right?
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium"
          >
            Yes
          </button>
          <button
            onClick={() => setShowPicker(true)}
            className="px-3 py-1.5 rounded-lg border border-[var(--md-primary)] text-[var(--md-on-primary-container)] text-sm"
          >
            Change
          </button>
        </div>
      </div>
    </div>
  );
}
