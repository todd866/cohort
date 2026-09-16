import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManagementCoverageFamily } from './types';
import {
  validateManagementCoverageFamily,
  validateManagementCoverageRegistry,
} from './validate';

export const DEFAULT_MANAGEMENT_COVERAGE_DIR = path.join(process.cwd(), 'coverage', 'management');

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    files.push(fullPath);
  }

  return files;
}

export function loadManagementCoverageFromDisk(options: {
  coverageDir?: string;
} = {}): {
  coverageDir: string;
  files: string[];
  families: ManagementCoverageFamily[];
  errors: string[];
} {
  const coverageDir = options.coverageDir ?? DEFAULT_MANAGEMENT_COVERAGE_DIR;
  const files = listJsonFiles(coverageDir).sort();
  const families: ManagementCoverageFamily[] = [];
  const errors: string[] = [];

  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${filePath}: invalid JSON (${error instanceof Error ? error.message : 'unknown error'})`);
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${filePath}: expected a single management coverage family object`);
      continue;
    }

    const family = {
      ...(parsed as ManagementCoverageFamily),
      sourceFile: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
    } satisfies ManagementCoverageFamily;

    const familyErrors = validateManagementCoverageFamily(family);
    if (familyErrors.length > 0) {
      for (const familyError of familyErrors) {
        errors.push(`${filePath}: ${familyError}`);
      }
      continue;
    }

    families.push(family);
  }

  const registryErrors = validateManagementCoverageRegistry(families);
  for (const registryError of registryErrors) {
    errors.push(`${coverageDir}: ${registryError}`);
  }

  return { coverageDir, files, families, errors };
}
