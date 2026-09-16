import { parse as parseYaml } from 'yaml';

export interface FrontmatterResult<TData extends object = Record<string, unknown>> {
  data: TData;
  content: string;
  matter: string;
}

const FRONTMATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function parseFrontmatter<TData extends object = Record<string, unknown>>(
  source: string
): FrontmatterResult<TData> {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return { data: {} as TData, content: stripBom(source), matter: '' };
  }

  const matter = match[1];
  const parsed = parseYaml(matter);
  const data = isRecord(parsed) ? parsed : {};

  return {
    data: data as TData,
    content: source.slice(match[0].length),
    matter,
  };
}

export default parseFrontmatter;
