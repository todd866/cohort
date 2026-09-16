import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { hashStringHex } from '@/lib/utils/hash';

export function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    return extractText(el.props.children);
  }
  return '';
}

export function normalizeSnapshot(text: string, maxLen = 280): string {
  const squashed = text.replace(/\s+/g, ' ').trim();
  if (squashed.length <= maxLen) return squashed;
  return `${squashed.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function buildFlagId(componentType: string, signature: string): string {
  const safeSignature = signature.length > 0 ? signature : componentType;
  const hash = hashStringHex(safeSignature);
  return `${componentType}:${hash}`;
}
