/**
 * Symptoms Chips
 *
 * Visual indicators for symptoms and signs.
 * Aviation principle: Quick visual scan.
 */

interface SymptomsChipsProps {
  symptoms: string[];
}

export function SymptomsChips({ symptoms }: SymptomsChipsProps) {
  if (symptoms.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {symptoms.map((symptom, i) => (
        <span
          key={i}
          className="px-2 py-1 rounded-md bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] text-sm"
        >
          {formatSymptom(symptom)}
        </span>
      ))}
    </div>
  );
}

function formatSymptom(symptom: string): string {
  // Capitalize first letter
  return symptom.charAt(0).toUpperCase() + symptom.slice(1);
}
