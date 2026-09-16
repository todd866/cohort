'use client';

import { useState } from 'react';

interface PathwayNode {
  label?: string;  // Optional when isBlank is true
  sublabel?: string;
  isBlank?: boolean;
  answer?: string;  // Required when isBlank is true
}

interface PathwayBranch {
  fromIndex: number;
  label?: string;
  nodes: PathwayNode[];
}

export interface PathwayCardProps {
  title?: string;
  nodes: PathwayNode[];
  branch?: PathwayBranch;
  link?: string; // contextual MDX link
}

function Node({
  node,
  revealed,
  onReveal
}: {
  node: PathwayNode;
  revealed: boolean;
  onReveal: () => void;
}) {
  const isBlank = node.isBlank && !revealed;

  return (
    <div
      onClick={node.isBlank ? onReveal : undefined}
      className={`
        px-4 py-3 rounded-xl text-center transition-all
        ${node.isBlank
          ? revealed
            ? 'bg-green-100 dark:bg-green-900/30 border-2 border-green-500'
            : 'bg-amber-100 dark:bg-amber-900/30 border-2 border-dashed border-amber-500 cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-900/50'
          : 'bg-[var(--md-surface-container-high)] border border-[var(--md-outline-variant)]'
        }
      `}
    >
      <div className="font-medium text-[var(--md-on-surface)]">
        {isBlank ? '?' : (node.answer || node.label)}
      </div>
      {node.sublabel && !isBlank && (
        <div className="text-xs text-[var(--md-on-surface-variant)] mt-0.5">
          {node.sublabel}
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function Arrow({ branching: _branching = false }: { branching?: boolean }) {
  return (
    <div className="flex justify-center py-1">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        className="text-[var(--md-outline)]"
      >
        <path
          d="M12 4 L12 16 M7 12 L12 17 L17 12"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _BranchArrow() {
  return (
    <div className="flex items-center gap-2 py-1 text-[var(--md-outline)]">
      <div className="flex-1 h-0.5 bg-current rounded" />
      <svg width="20" height="20" viewBox="0 0 20 20">
        <path
          d="M4 10 L16 10 M12 6 L16 10 L12 14"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function PathwayCard({ title, nodes, branch, link }: PathwayCardProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="bg-[var(--md-surface-container)] rounded-2xl p-5">
      {title && (
        <div className="text-sm font-medium text-[var(--md-on-surface-variant)] mb-4 text-center">
          {title}
        </div>
      )}

      <div className="flex gap-6">
        {/* Main pathway */}
        <div className="flex-1 flex flex-col">
          {nodes.map((node, i) => (
            <div key={i}>
              <Node node={node} revealed={revealed} onReveal={() => setRevealed(true)} />
              {i < nodes.length - 1 && <Arrow />}
            </div>
          ))}
        </div>

        {/* Branch pathway */}
        {branch && (
          <div className="flex-1 flex flex-col">
            {/* Spacer to align with branch point */}
            {branch.fromIndex > 0 && (
              <div style={{ height: `${branch.fromIndex * 72}px` }} />
            )}

            {/* Branch label */}
            {branch.label && (
              <div className="text-xs text-[var(--md-on-surface-variant)] text-center mb-2 italic">
                {branch.label}
              </div>
            )}

            {/* Branch nodes */}
            {branch.nodes.map((node, i) => (
              <div key={i}>
                <Node node={node} revealed={revealed} onReveal={() => setRevealed(true)} />
                {i < branch.nodes.length - 1 && <Arrow />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tap hint */}
      {!revealed && (nodes.some(n => n.isBlank) || branch?.nodes.some(n => n.isBlank)) && (
        <div className="text-xs text-[var(--md-on-surface-variant)] text-center mt-4 opacity-60">
          tap blank to reveal
        </div>
      )}

      {/* Context link */}
      {link && revealed && (
        <a
          href={link}
          className="block text-xs text-[var(--md-primary)] text-center mt-4 hover:underline"
        >
          Learn more →
        </a>
      )}
    </div>
  );
}
