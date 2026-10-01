'use client';

/**
 * ReferenceRanges component
 *
 * Displays standard reference ranges for lab values.
 * Use in MDX content to provide quick reference during interpretation questions.
 *
 * Usage:
 *   <ReferenceRanges type="abg" />
 *   <ReferenceRanges type="electrolytes" />
 *   <ReferenceRanges type="all" />
 */

interface ReferenceRangesProps {
  type?: 'abg' | 'electrolytes' | 'all';
  compact?: boolean;
}

const ABG_RANGES = {
  pH: '7.35-7.45',
  pCO2: '35-45 mmHg',
  pO2: '80-100 mmHg',
  HCO3: '22-26 mEq/L',
  'Base Excess': '-2 to +2',
  Lactate: '<2 mmol/L',
  'A-a gradient': '(Age/4) + 4',
};

const ELECTROLYTE_RANGES = {
  Na: '135-145 mmol/L',
  K: '3.5-5.0 mmol/L',
  Cl: '98-106 mmol/L',
  'Anion Gap': '8-12',
  Glucose: '3.5-5.5 mmol/L (fasting)',
  Ca: '2.1-2.6 mmol/L',
  Mg: '0.7-1.0 mmol/L',
};

export function ReferenceRanges({ type = 'abg', compact = false }: ReferenceRangesProps) {
  const showABG = type === 'abg' || type === 'all';
  const showElectrolytes = type === 'electrolytes' || type === 'all';

  if (compact) {
    return (
      <div className="my-2 px-3 py-2 text-xs bg-[var(--md-surface-container)] rounded-lg border border-[var(--md-outline-variant)]">
        <span className="font-semibold text-[var(--md-on-surface-variant)]">Reference: </span>
        {showABG && (
          <span className="text-[var(--md-on-surface-variant)]">
            pH 7.35-7.45 | pCO2 35-45 | pO2 80-100 | HCO3 22-26
          </span>
        )}
        {showABG && showElectrolytes && <span className="mx-2">•</span>}
        {showElectrolytes && (
          <span className="text-[var(--md-on-surface-variant)]">
            Na 135-145 | K 3.5-5.0 | Cl 98-106 | AG 8-12
          </span>
        )}
      </div>
    );
  }

  return (
    <div data-content-block className="my-4 overflow-hidden rounded-lg border border-[var(--md-outline-variant)]">
      <div className="bg-[var(--md-surface-container)] px-4 py-2 border-b border-[var(--md-outline-variant)]">
        <span className="text-sm font-semibold text-[var(--md-on-surface)]">
          Reference Ranges
        </span>
      </div>
      <div className="p-4 grid gap-4 md:grid-cols-2">
        {showABG && (
          <div>
            <h4 className="text-xs font-semibold text-[var(--md-on-surface-variant)] uppercase tracking-wider mb-2">
              Blood Gas
            </h4>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(ABG_RANGES).map(([param, range]) => (
                  <tr key={param} className="border-b border-[var(--md-outline-variant)] last:border-0">
                    <td className="py-1 font-medium text-[var(--md-on-surface)]">{param}</td>
                    <td className="py-1 text-right text-[var(--md-on-surface-variant)]">{range}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showElectrolytes && (
          <div>
            <h4 className="text-xs font-semibold text-[var(--md-on-surface-variant)] uppercase tracking-wider mb-2">
              Electrolytes
            </h4>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(ELECTROLYTE_RANGES).map(([param, range]) => (
                  <tr key={param} className="border-b border-[var(--md-outline-variant)] last:border-0">
                    <td className="py-1 font-medium text-[var(--md-on-surface)]">{param}</td>
                    <td className="py-1 text-right text-[var(--md-on-surface-variant)]">{range}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline reference text for use in explanations.
 * Returns just the string for embedding in other text.
 */
export function getABGReferenceString(): string {
  return 'pH 7.35-7.45 | pCO2 35-45 | pO2 80-100 | HCO3 22-26 | AG 8-12 | Lactate <2';
}

export function getElectrolyteReferenceString(): string {
  return 'Na 135-145 | K 3.5-5.0 | Cl 98-106';
}
