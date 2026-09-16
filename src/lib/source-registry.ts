import sourceData from './source-registry-data.json';

export interface SourceDefinition {
  slug: string;
  name: string;
  shortName: string;
  sourceType: 'guidelines' | 'textbook' | 'lecture' | 'uptodate' | 'peer-reviewed';
  reliability: 1 | 2 | 3 | 4 | 5;
  jurisdiction?: 'nsw' | 'wa' | 'national' | 'international' | null;
  publisher?: string;
  url?: string;
  aliases?: string[];
}

export const CORE_SOURCES: SourceDefinition[] = sourceData as SourceDefinition[];

function normalizeSourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s-]/g, '')
    .trim();
}

function getSourceSearchTerms(source: SourceDefinition): string[] {
  return [source.slug, source.name, source.shortName, ...(source.aliases ?? [])]
    .map((term) => normalizeSourceName(term))
    .filter((term) => term.length > 0);
}

const sourceByCanonicalSlug = new Map(CORE_SOURCES.map((source) => [source.slug, source]));
const exactSourceSlugByTerm = new Map<string, string>();

for (const source of CORE_SOURCES) {
  for (const term of getSourceSearchTerms(source)) {
    if (!exactSourceSlugByTerm.has(term)) {
      exactSourceSlugByTerm.set(term, source.slug);
    }
  }
}

exactSourceSlugByTerm.set('dsm-5', 'dsm5');
exactSourceSlugByTerm.set('crash-2', 'crash2');
exactSourceSlugByTerm.set('anzcor-14-2', 'anzcor');
exactSourceSlugByTerm.set('anzcor-14-3', 'anzcor');
exactSourceSlugByTerm.set('wsacs', 'wsacs-guidelines');
exactSourceSlugByTerm.set('asa', 'asa-classification');

export function resolveRegisteredSourceSlug(sourceRef: string): string | undefined {
  const normalized = normalizeSourceName(sourceRef);
  if (!normalized) return undefined;
  return exactSourceSlugByTerm.get(normalized);
}

export function getRegisteredSourceBySlug(slug: string): SourceDefinition | undefined {
  return sourceByCanonicalSlug.get(slug);
}

export function findRegisteredSourcesInText(sourceText: string): SourceDefinition[] {
  const normalized = normalizeSourceName(sourceText);
  const matches = new Map<string, SourceDefinition>();

  const exactSlug = resolveRegisteredSourceSlug(sourceText);
  if (exactSlug) {
    const exactSource = getRegisteredSourceBySlug(exactSlug);
    if (exactSource) {
      matches.set(exactSource.slug, exactSource);
    }
  }

  for (const source of CORE_SOURCES) {
    const exactMatch = getSourceSearchTerms(source).some((term) => term === normalized);
    if (exactMatch) {
      matches.set(source.slug, source);
    }
  }

  for (const source of CORE_SOURCES) {
    const containsMatch = getSourceSearchTerms(source).some((term) => term.length > 2 && normalized.includes(term));
    if (containsMatch) {
      matches.set(source.slug, source);
    }
  }

  return [...matches.values()];
}

export function matchRegisteredSourceName(sourceName: string): SourceDefinition | null {
  const exactSlug = resolveRegisteredSourceSlug(sourceName);
  if (exactSlug) {
    return getRegisteredSourceBySlug(exactSlug) ?? null;
  }

  return findRegisteredSourcesInText(sourceName)[0] ?? null;
}

export function extractSourceTextFromLine(line: string): string | null {
  const match = line.match(/^\s*(?:\*\*)?Sources?:(?:\*\*)?\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

export function extractSourceLineNames(content: string): string[] {
  const names: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const sourceText = extractSourceTextFromLine(line);
    if (!sourceText) continue;

    names.push(
      ...sourceText
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => part.replace(/\.$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim())
    );
  }

  return names;
}

export function inferSingleSourceSlugFromSourceLines(content: string): string | undefined {
  const matchedSlugs = new Set<string>();

  for (const sourceName of extractSourceLineNames(content)) {
    for (const source of findRegisteredSourcesInText(sourceName)) {
      matchedSlugs.add(source.slug);
    }
  }

  return matchedSlugs.size === 1 ? [...matchedSlugs][0] : undefined;
}
