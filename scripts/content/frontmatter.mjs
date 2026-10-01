import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function parseFrontmatter(source) {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return { data: {}, content: stripBom(source), matter: '' };
  }

  const matter = match[1];
  const parsed = parseYaml(matter);

  return {
    data: isRecord(parsed) ? parsed : {},
    content: source.slice(match[0].length),
    matter,
  };
}
