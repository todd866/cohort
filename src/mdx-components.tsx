import type { MDXComponents } from 'mdx/types';
import { isValidElement, type ReactNode } from 'react';

/** Recursively extract text content from React children for heading IDs */
function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/^[\d.]+-/, '');
}
import { transformClozeChildren } from '@/components/content/transformClozeChildren';
import {
  KeyPoint,
  ClinicalPearl,
  Danger,
  Mnemonic,
  QuestionBankMCQ,
  LearnMore,
  Video,
  DeepDive,
  DeepDiveLink,
  QuizTable,
  ImageOcclusion,
  Citation,
  SourceCitationBadge,
  SimpleCitation,
  SourceLine,
  AlgorithmSteps,
  DRSABCD,
  ABCDE,
  ISBAR,
  ShockQuadrants,
  ChestPainKillers,
  WikiLink,
  Term,
  ReferenceRanges,
} from '@/components/content';
// Note: MCQ.server cannot be imported here — the mdx-components module is traced
// into client bundles via deep-dive dynamic imports. MCQClient renders correctly
// for MDX-rendered MCQs; imageUrl passes through straight from MDX props.
import { MCQClient as MCQ } from '@/components/content/MCQ.client';
// Note: Figure.server cannot be imported here — the mdx-components module is traced
// into client bundles via deep-dive dynamic imports. FigureClient renders correctly
// for explicit <Figure> MDX JSX; auth/sidecar gating for MDX figures is Task 11b.
import { FigureClient as Figure } from '@/components/content/Figure.client';
import { ChecklistItem, StudyChecklist } from '@/components/content/ChecklistItem';
import { NeedImage } from '@/components/content/NeedImage';
import { ReviewableTable } from '@/components/review/ReviewableTable';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    // Pass through all default components
    ...components,

    // Custom components for study guides
    KeyPoint,
    ClinicalPearl,
    Danger,
    Mnemonic,
    MCQ,
    QuestionBankMCQ,
    LearnMore,
    Video,
    DeepDive,
    DeepDiveLink,
    QuizTable,
    Figure,
    ImageOcclusion,
    NeedImage,
    Citation,
    SourceCitationBadge,
    SimpleCitation,
    ChecklistItem,
    StudyChecklist,
    AlgorithmSteps,
    DRSABCD,
    ABCDE,
    ISBAR,
    ShockQuadrants,
    ChestPainKillers,
    WikiLink,
    Term,
    ReferenceRanges,

    // Override default elements with styled versions
    h1: ({ children }) => (
      <h1 className="text-3xl font-bold text-[var(--md-on-surface)] mb-4 mt-8 first:mt-0 first:hidden">
        {children}
      </h1>
    ),
    h2: ({ children, id, ...props }) => {
      const headingId = id || slugify(extractText(children)) || undefined;
      return (
        <h2
          id={headingId}
          data-content-block
          className="text-2xl font-bold text-[var(--md-secondary)] mb-3 mt-8 pb-1.5 border-b border-[var(--md-outline-variant)] scroll-mt-28"
          {...props}
        >
          {children}
        </h2>
      );
    },
    h3: ({ children }) => (
      <h3 data-content-block className="text-xl font-semibold text-[var(--md-on-surface)] mb-2 mt-6">
        {children}
      </h3>
    ),
    p: ({ children }) => {
      const text =
        typeof children === 'string' || typeof children === 'number'
          ? String(children)
          : Array.isArray(children) &&
              children.every((child) => typeof child === 'string' || typeof child === 'number')
            ? children.map(String).join('')
            : null;

      if (text) {
        const trimmed = text.trim();
        const match = /^(Source|Sources):\s*(.*)$/.exec(trimmed);

        if (match) {
          const label = match[1] as 'Source' | 'Sources';
          const rest = match[2].trim();

          return <SourceLine label={label}>{rest}</SourceLine>;
        }
      }

      return (
        <p className="text-[var(--md-on-surface)] mb-4 leading-relaxed">
          {transformClozeChildren(children)}
        </p>
      );
    },
    ul: ({ children }) => (
      <ul data-content-block className="list-disc list-inside mb-4 space-y-1 text-[var(--md-on-surface)]">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol data-content-block className="list-decimal list-inside mb-4 space-y-1 text-[var(--md-on-surface)]">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="ml-4">
        {transformClozeChildren(children)}
      </li>
    ),
    table: ReviewableTable,
    thead: ({ children }) => (
      <thead className="bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] border-b border-[var(--md-outline-variant)]">
        {children}
      </thead>
    ),
    th: ({ children }) => (
      <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-[var(--md-on-surface-variant)]">
        {transformClozeChildren(children)}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-2 border-b border-[var(--md-outline-soft)]">
        {transformClozeChildren(children)}
      </td>
    ),
    tr: ({ children }) => (
      <tr className="even:bg-[var(--md-surface-container)]">
        {children}
      </tr>
    ),
    pre: ({ children }) => (
      <pre data-content-block className="bg-[var(--md-surface-container-high)] p-4 rounded-lg mb-4 overflow-x-auto text-sm font-mono text-[var(--md-on-surface)]">
        {children}
      </pre>
    ),
    code: ({ children }) => (
      <code className="bg-[var(--md-surface-container-high)] px-1.5 py-0.5 rounded text-sm font-mono">
        {children}
      </code>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-[var(--md-on-surface)]">
        {children}
      </strong>
    ),
    a: ({ children, href }) => (
      <a
        href={href}
        className="text-[var(--md-primary)] hover:underline"
        target={href?.startsWith('http') ? '_blank' : undefined}
        rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    ),
    img: ({ src, alt, title }) => {
      if (!src || typeof src !== 'string') return null;
      return (
        <Figure
          src={src}
          alt={alt || ''}
          caption={title}
        />
      );
    },
  };
}
