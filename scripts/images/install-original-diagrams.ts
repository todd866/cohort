#!/usr/bin/env -S node --import tsx
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORIGINAL_FIGURE_ROOT,
  originalFigureSidecar,
  parseOriginalFigureManifest,
} from '../../src/lib/figures/original-figure-manifest';
import {
  readSafeOriginalFile,
  safeOriginalPath,
  validateOriginalPng,
} from '../../src/lib/figures/original-figure-files';
import { validateOriginalFigureScaffold } from '../../src/lib/figures/original-figure-scaffold';

export interface InstallOriginalDiagramsOptions { repoRoot?: string; write: boolean }

// Only these flat, installer-owned filenames may be removed. Do not recurse
// into adjacent figure collections or delete unrelated files in these folders.
const MANAGED_OUTPUT_FILES = [
  ['public/medical-diagrams', /^[a-f0-9]{64}\.png$/],
  ['public/figures/originals', /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/],
  ['figure-sidecars/originals', /^[a-z0-9]+(?:-[a-z0-9]+)*\.png\.json$/],
] as const;

function staleManagedOutputs(root: string, expected: Set<string>): string[] {
  const stale: string[] = [];
  for (const [directory, filenamePattern] of MANAGED_OUTPUT_FILES) {
    const path = safeOriginalPath(root, directory);
    let filenames: string[];
    try {
      if (!lstatSync(path).isDirectory()) throw new Error(`Original figures: not a directory ${directory}`);
      filenames = readdirSync(path).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const filename of filenames) {
      if (!filenamePattern.test(filename)) continue;
      const relative = `${directory}/${filename}`;
      const target = safeOriginalPath(root, relative);
      if (!lstatSync(target).isFile()) throw new Error(`Original figures: not a regular file ${relative}`);
      if (!expected.has(relative)) stale.push(relative);
    }
  }
  return stale;
}

/** Validate the entire collection and every output path before writes or removals. */
export function installOriginalDiagrams({ repoRoot = process.cwd(), write }: InstallOriginalDiagramsOptions) {
  const root = resolve(repoRoot);
  const manifest = parseOriginalFigureManifest(JSON.parse(
    readSafeOriginalFile(root, `${ORIGINAL_FIGURE_ROOT}/manifest.json`)!.toString('utf8'),
  ));
  const license = readSafeOriginalFile(root, `${ORIGINAL_FIGURE_ROOT}/LICENSE`)!.toString('utf8');
  if (!license.startsWith('MIT License') || !license.includes('Permission is hereby granted')
    || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    throw new Error('Original figures: full MIT LICENSE required');
  }

  const planned: Array<{ relative: string; bytes: Buffer; changed: boolean }> = [];
  const staticHashes = new Set<string>();
  for (const figure of manifest.figures) {
    const png = readSafeOriginalFile(root, `${ORIGINAL_FIGURE_ROOT}/${figure.file}`)!;
    validateOriginalPng(png, figure);
    for (const prompt of figure.generation.promptFiles) {
      if (!readSafeOriginalFile(root, `${ORIGINAL_FIGURE_ROOT}/${prompt}`)!.length) {
        throw new Error(`Original figures: empty prompt ${prompt}`);
      }
    }
    for (const specification of figure.review.structure.specificationFiles) {
      const bytes = readSafeOriginalFile(root, `${ORIGINAL_FIGURE_ROOT}/${specification}`)!;
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      validateOriginalFigureScaffold(parsed, figure.id);
    }
    const sidecar = Buffer.from(`${JSON.stringify(originalFigureSidecar(figure, manifest), null, 2)}\n`);
    for (const [relative, bytes] of [
      [`public/figures/originals/${figure.id}.png`, png],
      [`figure-sidecars/originals/${figure.id}.png.json`, sidecar],
    ] as const) {
      const existing = readSafeOriginalFile(root, relative, true);
      planned.push({ relative, bytes, changed: existing === null || !existing.equals(bytes) });
    }
    if (!staticHashes.has(figure.sha256)) {
      const relative = `public/medical-diagrams/${figure.sha256}.png`;
      const existing = readSafeOriginalFile(root, relative, true);
      planned.push({ relative, bytes: png, changed: existing === null || !existing.equals(png) });
      staticHashes.add(figure.sha256);
    }
  }

  // This path-only index is safe to import in the review client. The full
  // manifest includes teaching answers and remains a server/build dependency.
  const indexPath = 'src/lib/figures/original-figure-paths.json';
  const index = Buffer.from(`${JSON.stringify(
    manifest.figures.map((figure) => `/figures/originals/${figure.id}.png`).sort(),
    null, 2,
  )}\n`);
  const existingIndex = readSafeOriginalFile(root, indexPath, true);
  planned.push({ relative: indexPath, bytes: index, changed: existingIndex === null || !existingIndex.equals(index) });

  const stale = staleManagedOutputs(root, new Set(planned.map((output) => output.relative)));
  const changed = planned.filter((output) => output.changed);
  if (!write && (changed.length > 0 || stale.length > 0)) {
    throw new Error(`Original figures: ${changed.length} outputs out of date; ${stale.length} stale managed outputs; run with --write\n${[
      ...changed.map((output) => output.relative), ...stale,
    ].join('\n')}`);
  }
  if (write) {
    for (const output of changed) {
      const target = safeOriginalPath(root, output.relative);
      mkdirSync(dirname(target), { recursive: true });
      safeOriginalPath(root, output.relative);
      // Replacing the directory entry also avoids mutating an existing hardlink.
      const temp = join(dirname(target), `.original-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, output.bytes, { flag: 'wx' });
        renameSync(temp, target);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    for (const relative of stale) {
      // Recheck immediately before unlinking; never follow links or recursively
      // remove a directory that appeared after the complete preflight above.
      const target = safeOriginalPath(root, relative);
      if (!lstatSync(target).isFile()) throw new Error(`Original figures: not a regular file ${relative}`);
      unlinkSync(target);
    }
  }
  return { manifest, figures: manifest.figures.length, written: write ? changed.length : 0,
    removed: write ? stale.length : 0, unchanged: planned.length - changed.length };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--write', '--check'].includes(args[0])) {
    throw new Error('Usage: install-original-diagrams.ts --write|--check');
  }
  const result = installOriginalDiagrams({ write: args[0] === '--write' });
  console.log(`[original-diagrams] ${result.figures} figures validated; ${result.written} files written; ${result.removed} stale files removed; ${result.unchanged} files already current`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
