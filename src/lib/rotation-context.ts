export type RotationId = string;
export type TrackNumber = 1 | 2 | 3 | 4;

export const TRACKS: Record<TrackNumber, readonly RotationId[]> = {
  1: [],
  2: [],
  3: [],
  4: [],
};

export const ROTATIONS: ReadonlyArray<{
  id: RotationId;
  name: string;
  short: string;
  color: string;
}> = [];

export const BLOCKS: ReadonlyArray<{
  num: number;
  start: Date;
  exam: Date;
  examStr: string;
}> = [];

export const TRACK_SCHEDULES: Record<TrackNumber, {
  rotations: readonly string[];
  description: string;
}> = {
  1: { rotations: [], description: 'Not configured' },
  2: { rotations: [], description: 'Not configured' },
  3: { rotations: [], description: 'Not configured' },
  4: { rotations: [], description: 'Not configured' },
};

const STORAGE_KEY = 'md3_current_rotation';
const STORAGE_EVENT = 'md3_rotation_changed';

export function getStoredRotation(): RotationId | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  return ROTATIONS.some((rotation) => rotation.id === stored)
    ? stored as RotationId
    : null;
}

export function setStoredRotation(rotationId: RotationId): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, rotationId);
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

export function subscribeToRotationChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener('storage', handleStorage);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}

export function getBlockExamDate(_rotationId: string, _track: TrackNumber = 1): Date | null {
  void _rotationId;
  void _track;
  return null;
}

export function getBlockStartDate(_rotationId: string, _track: TrackNumber = 1): Date | null {
  void _rotationId;
  void _track;
  return null;
}

export function getCurrentWeek(): number {
  return 1;
}

export function getCurrentBlockIndex(): number {
  return 0;
}

export function inferTrackFromRotation(_rotationId: RotationId): TrackNumber {
  void _rotationId;
  return 1;
}

export function getRotationForTrack(_track: TrackNumber, _blockIndex: number): RotationId {
  void _track;
  void _blockIndex;
  return 'open-learning';
}

export function getActiveRotations(_track: TrackNumber): RotationId[] {
  void _track;
  return [];
}
