import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_CALIBRATION_DIR = path.resolve(
  process.env.CALIBRATION_PATH ?? path.join(process.cwd(), '.md3-calibration'),
);
export const DEFAULT_CALIBRATION_REGION = 'default';
export const DEFAULT_CALIBRATION_SOURCE_PREFERENCE: string[] = [];

export interface ManagementCalibrationSource {
  calibrationDir: string;
  sourceKey: string;
  sourcePath: string;
  talkPagesDir: string;
}

export function parseFlagValue(args: string[], flag: string): string | null {
  const inlinePrefix = `${flag}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length);
  }

  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]!;
  }

  return null;
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    files.push(fullPath);
  }

  return files;
}

export function listAvailableCalibrationSources(calibrationDir = DEFAULT_CALIBRATION_DIR): string[] {
  if (!fs.existsSync(calibrationDir)) {
    return [];
  }

  const sources: string[] = [];
  const regionDirs = fs.readdirSync(calibrationDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const regionDir of regionDirs) {
    const regionPath = path.join(calibrationDir, regionDir.name);
    const sourceDirs = fs.readdirSync(regionPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const sourceDir of sourceDirs) {
      const examDataPath = path.join(regionPath, sourceDir.name, 'exam-questions-verbatim.json');
      if (fs.existsSync(examDataPath)) {
        sources.push(`${regionDir.name}/${sourceDir.name}`);
      }
    }
  }

  return sources.sort();
}

export function resolveCalibrationSource(options: {
  requestedSource?: string | null;
  calibrationDir?: string;
  defaultRegion?: string;
  sourcePreference?: string[];
} = {}): ManagementCalibrationSource {
  const calibrationDir = options.calibrationDir ?? DEFAULT_CALIBRATION_DIR;
  const defaultRegion = options.defaultRegion ?? DEFAULT_CALIBRATION_REGION;
  const sourcePreference = options.sourcePreference ?? DEFAULT_CALIBRATION_SOURCE_PREFERENCE;
  const availableSources = listAvailableCalibrationSources(calibrationDir);

  let sourceKey: string | null = null;
  if (options.requestedSource) {
    sourceKey = options.requestedSource.includes('/')
      ? options.requestedSource
      : `${defaultRegion}/${options.requestedSource}`;
  } else {
    sourceKey =
      sourcePreference
        .map((source) => `${defaultRegion}/${source}`)
        .find((candidate) => availableSources.includes(candidate)) ||
      availableSources[0] ||
      null;
  }

  if (!sourceKey) {
    throw new Error(`No calibration sources found under ${calibrationDir}`);
  }

  const sourcePath = path.join(calibrationDir, sourceKey);
  const talkPagesDir = path.join(sourcePath, 'talk-pages');
  const examDataPath = path.join(sourcePath, 'exam-questions-verbatim.json');

  if (!fs.existsSync(examDataPath)) {
    const known = availableSources.length > 0 ? ` Available sources: ${availableSources.join(', ')}` : '';
    throw new Error(`Calibration data not found for source "${sourceKey}".${known}`);
  }

  return {
    calibrationDir,
    sourceKey,
    sourcePath,
    talkPagesDir,
  };
}

export function listCalibrationLinkIds(
  source: ManagementCalibrationSource,
  options: {
    include?: (relativeId: string) => boolean;
  } = {}
): string[] {
  const files = listMarkdownFiles(source.talkPagesDir);
  const ids: string[] = [];

  for (const filePath of files) {
    const relativeId = path.relative(source.calibrationDir, filePath).replace(/\\/g, '/');
    if (options.include && !options.include(relativeId)) continue;
    ids.push(relativeId);
  }

  return ids.sort();
}
