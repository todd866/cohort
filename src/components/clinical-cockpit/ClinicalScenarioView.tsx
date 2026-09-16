/**
 * Clinical Scenario View
 *
 * Main wrapper that parses a question stem and renders the cockpit.
 * Falls back to plain text if not a clinical scenario or parsing fails.
 */

'use client';

import { useMemo } from 'react';
import { parseScenario, type ParsedScenario } from '@/lib/clinical-parser';
import { PatientBanner } from './PatientBanner';
import { VitalsDisplay } from './VitalsDisplay';
import { LabsPanel } from './LabsPanel';
import { ABGPanel, isABGLab } from './ABGPanel';
import { SymptomsChips } from './SymptomsChips';
import { GlossaryText } from '@/components/content';

interface ClinicalScenarioViewProps {
  stem: string;
  showIssues?: boolean; // For content audit mode
}

export function ClinicalScenarioView({ stem, showIssues = false }: ClinicalScenarioViewProps) {
  const parsed = useMemo(() => parseScenario(stem), [stem]);

  // Not a clinical scenario - show plain text
  if (!parsed.isClinicalScenario) {
    return <PlainTextStem text={stem} />;
  }

  // Low confidence - show hybrid view
  if (parsed.confidence < 0.25) {
    return <PlainTextStem text={stem} />;
  }

  // Get timeline for banner
  const timeline = parsed.timeline.length > 0 ? parsed.timeline[0].time : undefined;

  // Split labs into ABG and other
  const abgLabs = parsed.labs.filter(isABGLab);
  const otherLabs = parsed.labs.filter(lab => !isABGLab(lab));

  // Has extracted data worth displaying?
  const hasVitals = Object.keys(parsed.vitals).length > 0;
  const hasABG = abgLabs.length > 0;
  const hasOtherLabs = otherLabs.length > 0;
  const hasSymptoms = parsed.symptoms.length > 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _hasContext = parsed.context.length > 0;
  const hasDemographics = parsed.demographics.age !== null || parsed.demographics.sex !== 'unknown';

  const hasExtractedData = hasVitals || hasABG || hasOtherLabs || hasSymptoms || hasDemographics;

  if (!hasExtractedData) {
    return <PlainTextStem text={stem} />;
  }

  return (
    <div className="space-y-3">
      {/* Patient Banner */}
      <PatientBanner
        demographics={parsed.demographics}
        context={parsed.context}
        timeline={timeline}
      />

      {/* Vitals */}
      {hasVitals && (
        <div>
          <VitalsDisplay vitals={parsed.vitals} />
        </div>
      )}

      {/* ABG - structured display */}
      {hasABG && (
        <div>
          <ABGPanel labs={abgLabs} />
        </div>
      )}

      {/* Other Labs */}
      {hasOtherLabs && (
        <div>
          <LabsPanel labs={otherLabs} />
        </div>
      )}

      {/* Symptoms */}
      {hasSymptoms && (
        <div>
          <SymptomsChips symptoms={parsed.symptoms} />
        </div>
      )}

      {/* The actual question */}
      {parsed.question && (
        <div className="pt-2 border-t border-[var(--md-outline-variant)]">
          <p className="text-[var(--md-on-surface)] font-medium">
            <GlossaryText text={parsed.question} />
          </p>
        </div>
      )}

      {/* Issues for content audit */}
      {showIssues && parsed.issues.length > 0 && (
        <IssuesPanel issues={parsed.issues} />
      )}
    </div>
  );
}

function PlainTextStem({ text }: { text: string }) {
  return (
    <div className="text-[var(--md-on-surface)] whitespace-pre-wrap">
      <GlossaryText text={text} />
    </div>
  );
}

function IssuesPanel({ issues }: { issues: ParsedScenario['issues'] }) {
  return (
    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 space-y-1">
      <div className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
        Content Issues
      </div>
      {issues.map((issue, i) => (
        <div key={i} className="text-sm text-red-600 dark:text-red-400">
          <span className="font-medium">{issue.type}:</span> {issue.message}
          {issue.rawText && (
            <code className="ml-1 px-1 py-0.5 rounded bg-red-500/10 text-xs">
              {issue.rawText}
            </code>
          )}
        </div>
      ))}
    </div>
  );
}

// Export parsed scenario for when caller needs the data
export function useParsedScenario(stem: string): ParsedScenario {
  return useMemo(() => parseScenario(stem), [stem]);
}
