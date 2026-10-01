import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ORIGINAL_FIGURE_ROOT, type OriginalFigure } from './original-figure-manifest';

/** Reject links in every existing component below the selected repository root. */
export function safeOriginalPath(repoRoot: string, relative: string): string {
  if (!relative || isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Original figures: unsafe path ${relative}`);
  }
  let current = resolve(repoRoot);
  const parts = relative.split('/');
  for (let i = -1; i < parts.length; i += 1) {
    if (i >= 0) current = join(current, parts[i]);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Original figures: symlink refused at ${current}`);
      if (i < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Original figures: non-directory parent ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

export function readSafeOriginalFile(repoRoot: string, relative: string, optional = false): Buffer | null {
  const path = safeOriginalPath(repoRoot, relative);
  try {
    if (!lstatSync(path).isFile()) throw new Error(`Original figures: not a regular file ${relative}`);
    return readFileSync(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Hash receipts are checked along with actual PNG header dimensions. */
export function validateOriginalPng(bytes: Buffer, figure: OriginalFigure): void {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !bytes.subarray(-8, -4).equals(Buffer.from('IEND'))) {
    throw new Error(`Original figures: invalid PNG ${figure.id}`);
  }
  if (bytes.readUInt32BE(16) !== figure.width || bytes.readUInt32BE(20) !== figure.height) {
    throw new Error(`Original figures: PNG dimensions differ for ${figure.id}`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== figure.sha256) {
    throw new Error(`Original figures: PNG hash differs for ${figure.id}`);
  }
}

/** A bad served copy fails closed; only an absent copy permits the canonical fallback. */
export function readOriginalFigureBytes(figure: OriginalFigure, repoRoot = process.cwd()): Buffer | null {
  try {
    const installed = readSafeOriginalFile(repoRoot, `public/figures/originals/${figure.id}.png`, true);
    const bytes = installed ?? readSafeOriginalFile(repoRoot, `${ORIGINAL_FIGURE_ROOT}/${figure.file}`);
    if (!bytes) return null;
    validateOriginalPng(bytes, figure);
    return bytes;
  } catch {
    return null;
  }
}
