'use client';

import { useState } from 'react';

interface Step {
  letter: string;
  title: string;
  description: string;
  color: string;
  details?: string[];
}

interface AlgorithmStepsProps {
  title: string;
  subtitle?: string;
  steps: Step[];
  columns?: 1 | 2;
}

export function AlgorithmSteps({
  title,
  subtitle,
  steps,
  columns = 2,
}: AlgorithmStepsProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <div className="my-6 overflow-hidden rounded-xl border">
      <div className="border-b px-4 py-3">
        <h3 className="text-xl font-bold">{title}</h3>
        {subtitle ? <p className="mt-1 text-sm">{subtitle}</p> : null}
      </div>
      <div className={`grid grid-cols-1 gap-3 p-4 ${columns === 2 ? 'md:grid-cols-2' : ''}`}>
        {steps.map((step, index) => (
          <button
            className="flex items-start gap-3 rounded-lg border p-4 text-left"
            key={`${step.letter}-${index}`}
            onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
            type="button"
          >
            <span
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl font-bold text-white"
              style={{ backgroundColor: step.color }}
            >
              {step.letter}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{step.title}</span>
              <span className="mt-1 block text-sm">{step.description}</span>
              {expandedIndex === index && step.details ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {step.details.map((detail) => <li key={detail}>{detail}</li>)}
                </ul>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function DRSABCD() { return null; }
export function ABCDE() { return null; }
export function ISBAR() { return null; }
export function ShockQuadrants() { return null; }
export function ChestPainKillers() { return null; }
