import { isValidElement, Children, type ReactNode, type ReactElement } from 'react';
import { InlineCloze } from './InlineCloze';

const BLANK_PATTERN = /\[(?:___|\\_\\_\\_)\]/;
const BLANK_PATTERN_GLOBAL = /\[(?:___|\\_\\_\\_)\]/g;

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

function hasBlank(text: string): boolean {
  return BLANK_PATTERN.test(text);
}

function countBlanks(text: string): number {
  return text.match(BLANK_PATTERN_GLOBAL)?.length ?? 0;
}

function splitByBlank(text: string): string[] {
  return text.split(BLANK_PATTERN_GLOBAL);
}

function isLabelStrong(el: ReactElement, label: string): boolean {
  if (!isStrongLike(el)) return false;
  return extractText((el.props as { children?: ReactNode }).children).trim().toUpperCase() === label;
}

function extractDelimitedAnswers(nodes: ReactNode[]): ReactNode[] {
  const text = extractText(nodes).trim();
  if (!text) return [];
  return text
    .split(/\s*;\s*/g)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

/**
 * Check if a React element is a <strong> — either native HTML or MDX custom component.
 * MDX replaces 'strong' with a custom function component from useMDXComponents,
 * so we can't just check `el.type === 'strong'`.
 */
function isStrongLike(el: ReactElement): boolean {
  // Native HTML <strong>
  if (el.type === 'strong') return true;
  // MDX custom component override — any function/component that follows [___]
  // and has children (the answer text) is treated as the answer element.
  // MDX always renders **bold** as the custom strong override.
  if (typeof el.type === 'function') return true;
  return false;
}

/**
 * Walk MDX children and replace `[___] **answer**` patterns with <InlineCloze>.
 *
 * MDX renders `[___] **answer**` as adjacent children:
 *   - text containing "[___] " (trailing space)
 *   - <strong>answer</strong> (or MDX custom strong component)
 *
 * This function pairs each [___] with the next <strong> sibling.
 *
 * Runs on the server — InlineCloze is a client component rendered via reference.
 */
export function transformClozeChildren(children: ReactNode): ReactNode {
  const flat = Children.toArray(children);
  const answerMarkerIndex = flat.findIndex(
    (child) => isValidElement(child) && isLabelStrong(child, 'A:')
  );
  const renderableChildren = answerMarkerIndex >= 0 ? flat.slice(0, answerMarkerIndex) : flat;
  const qaAnswers =
    answerMarkerIndex >= 0 ? extractDelimitedAnswers(flat.slice(answerMarkerIndex + 1)) : [];

  if (!renderableChildren.some((child) => typeof child === 'string' && hasBlank(child))) {
    return children;
  }

  // Collect all <strong> answers in order (consume from front)
  const strongQueue: ReactNode[] = [];
  const strongIndices = new Set<number>();

  // First pass: identify <strong> elements that follow a [___] text node
  for (let i = 0; i < renderableChildren.length; i++) {
    const child = renderableChildren[i];
    if (typeof child === 'string' && hasBlank(child)) {
      // Count blanks in this text node
      const blankCount = countBlanks(child);
      // Look ahead for that many <strong> elements
      let found = 0;
      for (let j = i + 1; j < renderableChildren.length && found < blankCount; j++) {
        const next = renderableChildren[j];
        if (isValidElement(next) && isStrongLike(next) && !isLabelStrong(next, 'Q:') && !isLabelStrong(next, 'A:')) {
          strongQueue.push((next.props as { children?: ReactNode }).children);
          strongIndices.add(j);
          found++;
        } else if (typeof next === 'string' && next.trim() === '') {
          continue; // skip whitespace between blank and answer
        } else {
          break; // non-strong, non-whitespace — stop looking
        }
      }
    }
  }

  // Second pass: build output
  const result: ReactNode[] = [];
  let strongAnswerIdx = 0;
  let qaAnswerIdx = 0;

  for (let i = 0; i < renderableChildren.length; i++) {
    if (strongIndices.has(i)) continue; // consumed as answer

    const child = renderableChildren[i];

    if (typeof child === 'string' && hasBlank(child)) {
      const parts = splitByBlank(child);
      for (let k = 0; k < parts.length; k++) {
        if (parts[k]) result.push(parts[k]);
        if (k < parts.length - 1) {
          if (strongAnswerIdx < strongQueue.length) {
            result.push(<InlineCloze key={`cloze-${i}-${k}`} answer={strongQueue[strongAnswerIdx++]} />);
          } else if (qaAnswerIdx < qaAnswers.length) {
            result.push(<InlineCloze key={`cloze-${i}-${k}`} answer={qaAnswers[qaAnswerIdx++]} />);
          } else {
            // No answer available — render as styled blank
            result.push(
              <span key={`blank-${i}-${k}`} className="inline-block min-w-[3rem] text-center px-2 py-0.5 rounded-md bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]">
                ___
              </span>
            );
          }
        }
      }
    } else {
      result.push(child);
    }
  }

  return result;
}
