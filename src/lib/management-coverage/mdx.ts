import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_CONTENT_DIR = path.join(process.cwd(), 'content');

function listMdxFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMdxFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;
    files.push(fullPath);
  }

  return files;
}

function stripHeadingMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[\d.]+-/, '');
}

export function loadMdxSectionIdsFromDisk(options: {
  contentDir?: string;
} = {}): {
  contentDir: string;
  files: string[];
  sectionIds: Set<string>;
  errors: string[];
} {
  const contentDir = options.contentDir ?? DEFAULT_CONTENT_DIR;
  const files = listMdxFiles(contentDir).sort();
  const sectionIds = new Set<string>();
  const errors: string[] = [];
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/gm;

  for (const filePath of files) {
    let source = '';
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : 'failed to read file'}`);
      continue;
    }

    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(source))) {
      const headingText = stripHeadingMarkup(match[2] ?? '');
      const slug = slugifyHeading(headingText);
      if (!slug) continue;
      sectionIds.add(`${relativePath}#${slug}`);
    }
  }

  return { contentDir, files, sectionIds, errors };
}
