/**
 * Vitals Display
 *
 * Visual representation of vital signs with abnormal highlighting.
 * Aviation principle: Color coding + spatial consistency.
 */

import type { Vitals, Flag } from '@/lib/clinical-parser/types';

interface VitalsDisplayProps {
  vitals: Vitals;
}

export function VitalsDisplay({ vitals }: VitalsDisplayProps) {
  const hasVitals = Object.keys(vitals).length > 0;

  if (!hasVitals) return null;

  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
      {vitals.hr && <VitalBox label="HR" value={vitals.hr.value} unit="bpm" flag={vitals.hr.flag} qualitative={vitals.hr.qualitative} />}
      {vitals.bp && <BPBox systolic={vitals.bp.systolic} diastolic={vitals.bp.diastolic} flag={vitals.bp.flag} qualitative={vitals.bp.qualitative} />}
      {vitals.temp && <VitalBox label="Temp" value={vitals.temp.value} unit="°C" flag={vitals.temp.flag} qualitative={vitals.temp.qualitative} />}
      {vitals.rr && <VitalBox label="RR" value={vitals.rr.value} unit="/min" flag={vitals.rr.flag} qualitative={vitals.rr.qualitative} />}
      {vitals.spo2 && <VitalBox label="SpO₂" value={vitals.spo2.value} unit="%" flag={vitals.spo2.flag} qualitative={vitals.spo2.qualitative} />}
      {vitals.gcs && <VitalBox label="GCS" value={vitals.gcs.value} unit="" flag={vitals.gcs.flag} qualitative={vitals.gcs.qualitative} />}
    </div>
  );
}

interface VitalBoxProps {
  label: string;
  value: number | null;
  unit: string;
  flag: Flag;
  qualitative?: string;
}

function VitalBox({ label, value, unit, flag, qualitative }: VitalBoxProps) {
  const { bg, text, indicator } = getFlagStyles(flag);

  return (
    <div className={`p-2 rounded-lg text-center ${bg}`}>
      <div className={`text-xs uppercase tracking-wide ${text} opacity-70`}>{label}</div>
      <div className={`text-lg font-semibold ${text} flex items-center justify-center gap-1`}>
        {value !== null ? (
          <>
            {value}
            <span className="text-xs font-normal opacity-60">{unit}</span>
          </>
        ) : qualitative ? (
          <span className="text-sm">{formatQualitative(qualitative)}</span>
        ) : (
          <span className="opacity-40">—</span>
        )}
        {indicator && <span className="ml-1">{indicator}</span>}
      </div>
    </div>
  );
}

interface BPBoxProps {
  systolic: number | null;
  diastolic: number | null;
  flag: Flag;
  qualitative?: string;
}

function BPBox({ systolic, diastolic, flag, qualitative }: BPBoxProps) {
  const { bg, text, indicator } = getFlagStyles(flag);

  return (
    <div className={`p-2 rounded-lg text-center ${bg}`}>
      <div className={`text-xs uppercase tracking-wide ${text} opacity-70`}>BP</div>
      <div className={`text-lg font-semibold ${text} flex items-center justify-center gap-1`}>
        {systolic !== null && diastolic !== null ? (
          <>
            {systolic}/{diastolic}
          </>
        ) : qualitative ? (
          <span className="text-sm">{formatQualitative(qualitative)}</span>
        ) : (
          <span className="opacity-40">—</span>
        )}
        {indicator && <span className="ml-1">{indicator}</span>}
      </div>
    </div>
  );
}

function getFlagStyles(flag: Flag): { bg: string; text: string; indicator: string | null } {
  switch (flag) {
    case 'critical-high':
      return {
        bg: 'bg-red-500/20',
        text: 'text-red-600 dark:text-red-400',
        indicator: '↑↑',
      };
    case 'critical-low':
      return {
        bg: 'bg-red-500/20',
        text: 'text-red-600 dark:text-red-400',
        indicator: '↓↓',
      };
    case 'high':
      return {
        bg: 'bg-amber-500/20',
        text: 'text-amber-700 dark:text-amber-400',
        indicator: '↑',
      };
    case 'low':
      return {
        bg: 'bg-amber-500/20',
        text: 'text-amber-700 dark:text-amber-400',
        indicator: '↓',
      };
    default:
      return {
        bg: 'bg-[var(--md-surface-container)]',
        text: 'text-[var(--md-on-surface)]',
        indicator: null,
      };
  }
}

function formatQualitative(q: string): string {
  // Capitalize and format qualitative descriptors
  const formatted = q.toLowerCase();
  const map: Record<string, string> = {
    tachycardic: 'Tachy',
    bradycardic: 'Brady',
    hypotensive: '↓',
    hypertensive: '↑',
    febrile: 'Febrile',
    hypothermic: 'Hypo',
    tachypneic: 'Tachy',
    hypoxic: 'Hypoxic',
  };
  return map[formatted] || q;
}
