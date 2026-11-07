import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const STORED_LABEL = 'gemini-embedding-2-preview';
const API_MODEL = 'gemini-embedding-2';
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'out']);

function sourceText(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exportedString(source: string, name: string): string | undefined {
  return source.match(new RegExp(`export const ${name} = '([^']*)'`))?.[1];
}

function codeFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      codeFiles(fullPath, found);
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      found.push(fullPath);
    }
  }
  return found;
}

/** Call sites that still hand the stored label to the Gemini client. */
function labelModelCalls(root: string): string[] {
  const hits: string[] = [];
  const callPattern = /getGenerativeModel\s*\(\s*\{[\s\S]*?\}\s*\)/g;
  const labelPattern = /\bmodel\s*:\s*(?:EMBEDDING_MODEL|MANIFOLD_MODEL)\b/;
  for (const filePath of codeFiles(root)) {
    const text = readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(callPattern)) {
      if (!labelPattern.test(match[0])) continue;
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      hits.push(`${path.relative(root, filePath)}:${line}`);
    }
  }
  return hits;
}

describe('gemini embedding model ids', () => {
  it('keeps stored labels on the preview name and keeps that name out of getGenerativeModel', () => {
    // A label change without a migration makes stored rows look like a new vector space.
    expect(exportedString(sourceText('scripts/lib/gemini.ts'), 'EMBEDDING_MODEL')).toBe(STORED_LABEL);
    expect(exportedString(sourceText('src/lib/manifold/config.ts'), 'MANIFOLD_MODEL')).toBe(STORED_LABEL);
    // Passing the label constant calls the retired preview id.
    expect(exportedString(sourceText('scripts/lib/gemini.ts'), 'EMBEDDING_API_MODEL')).toBe(API_MODEL);
    expect(exportedString(sourceText('src/lib/manifold/config.ts'), 'MANIFOLD_API_MODEL')).toBe(API_MODEL);
    expect(labelModelCalls(ROOT)).toEqual([]);
  });
});
