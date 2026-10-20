import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CREDENTIAL_SHAPES } from './describe-error.mjs';

// A repository can legitimately have more than one megabyte of tracked path
// names. Keep the capture bounded, but large enough that enumeration itself
// cannot make the scanner silently miss the tail of the index.
const GIT_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    ...options,
  });
}

function getRepoRoot() {
  return runGit(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function parseNullSeparated(output) {
  if (!output) return [];
  return output.split('\0').filter(Boolean);
}

function getTrackedFiles() {
  return parseNullSeparated(runGit(['ls-files', '-z'], { encoding: 'utf8' }));
}

function getStagedFiles() {
  return parseNullSeparated(
    runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
      encoding: 'utf8',
    })
  );
}

function getStagedFileContent(filePath) {
  // Read content from the git index (staged version), not from the working tree.
  return runGit(['show', `:${filePath}`]);
}

function isBinaryContent(buffer) {
  // Heuristic: null byte in first chunk.
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

function redact(match) {
  const value = String(match);
  if (value.length <= 12) return '[REDACTED]';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function shouldSkipPath(filePath) {
  // Only scan tracked/staged files; these are repo-relative paths.
  // Skip lockfiles if you want less noise (but still safe to scan).
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.startsWith('.git/')) return true;
  return false;
}

function isForbiddenEnvFile(filePath) {
  const base = path.posix.basename(filePath.replaceAll('\\', '/'));
  if (!base.startsWith('.env')) return false;
  // Allow env examples/templates only.
  return !/(?:\.example|\.sample|\.template)$/i.test(base);
}

// The token shapes live in describe-error.mjs, shared with log redaction and
// the tutor daemon's answer hold, so the three cannot drift apart. Shapes the
// repo legitimately documents (postgresql://user:password@host examples) are
// marked trackedFiles: false there and skipped here; a private key is matched
// as a whole block below.
const LINE_PATTERNS = CREDENTIAL_SHAPES
  .filter((shape) => shape.trackedFiles !== false)
  .map(({ name, pattern }) => ({ name, regex: new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`) }));

const FILE_PATTERNS = [
  {
    name: 'Private key block',
    regex:
      /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
  },
];

const SECRET_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=|:)\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s,;#}]+))/g;
const PLACEHOLDER_VALUE = /(?:placeholder|not[-_]?a[-_]?real|redacted|changeme|replace[-_]?me)/i;
const PLACEHOLDER_PREFIX = /^(?:dummy|test|fake|example|sample|placeholder|generate|your|from)(?:[-_:]|$)/i;

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isCredentialAssignmentName(name) {
  // Normalise camelCase so credential words must be complete identifier
  // segments. This catches clientSecret and *_API_TOKEN without treating
  // ordinary names such as max_tokens as credentials.
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return /(?:^|[_.-])(?:secret|token|password|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_.-])/.test(normalized);
}

export function isLikelySecretAssignmentValue(value) {
  const candidate = value.trim();
  if (candidate.length < 24 || candidate.length > 4096) return false;
  if (PLACEHOLDER_VALUE.test(candidate) || PLACEHOLDER_PREFIX.test(candidate)) return false;
  if (candidate.includes('${') || candidate.includes('<') || candidate.includes('>')) return false;
  if (/^(?:process|import)\.env\b/.test(candidate)) return false;
  // Constants used as configuration values are references, not literal
  // credentials (for example CHAT_MAX_RESPONSE_TOKENS).
  if (/^[A-Z][A-Z0-9_]*$/.test(candidate)) return false;
  if (!/^[A-Za-z0-9+/_=.:-]+$/.test(candidate)) return false;
  if (new Set(candidate).size < 8) return false;
  return shannonEntropy(candidate) >= 3;
}

function scanGenericAssignments(line, report, filePath, lineNumber) {
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    if (!isCredentialAssignmentName(name) || !isLikelySecretAssignmentValue(value)) continue;
    report.push({
      filePath,
      lineNumber,
      pattern: `High-entropy credential assignment (${name})`,
      match: redact(value),
    });
  }
}

function scanTextByLine(text, report, filePath) {
  const lines = text.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    if (!line) continue;

    // Allowlist: a line containing this marker is ignored by this scanner.
    if (line.includes('secret-scan: allow')) continue;

    for (const pattern of LINE_PATTERNS) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(line);
      if (match) {
        report.push({
          filePath,
          lineNumber: lineNumber + 1,
          pattern: pattern.name,
          match: redact(match[0]),
        });
      }
    }

    scanGenericAssignments(line, report, filePath, lineNumber + 1);
  }
}

function scanTextWhole(text, report, filePath) {
  for (const pattern of FILE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const match = pattern.regex.exec(text);
    if (match) {
      report.push({
        filePath,
        lineNumber: null,
        pattern: pattern.name,
        match: '[REDACTED]',
      });
    }
  }
}

export function scanContent(text, filePath = '<memory>') {
  const findings = [];
  scanTextWhole(text, findings, filePath);
  scanTextByLine(text, findings, filePath);
  return findings;
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/secret-scan.mjs --tracked   # scan git-tracked files (CI)
  node scripts/ops/secret-scan.mjs --staged    # scan staged files (pre-commit)

Notes:
- Lines containing "secret-scan: allow" are ignored.
- This is a lightweight guard; rotate/revoke anything that ever lands in git.`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    process.exit(0);
  }

  const scanTracked = args.has('--tracked');
  const scanStaged = args.has('--staged');
  if (!scanTracked && !scanStaged) {
    printUsage();
    process.exit(2);
  }

  const repoRoot = getRepoRoot();
  const stagedFiles = scanStaged ? getStagedFiles() : [];
  const stagedFilesSet = new Set(stagedFiles);

  const files = new Set();
  if (scanTracked) for (const file of getTrackedFiles()) files.add(file);
  if (scanStaged) for (const file of stagedFiles) files.add(file);

  const findings = [];

  for (const filePath of files) {
    if (shouldSkipPath(filePath)) continue;

    if (isForbiddenEnvFile(filePath)) {
      findings.push({
        filePath,
        lineNumber: null,
        pattern: 'Forbidden env file',
        match: path.posix.basename(filePath.replaceAll('\\', '/')),
      });
      continue;
    }

    const absolutePath = path.join(repoRoot, filePath);
    let content = null;
    let buffer = null;

    try {
      if (scanStaged && stagedFilesSet.has(filePath)) {
        buffer = getStagedFileContent(filePath);
        if (isBinaryContent(buffer)) continue;
        content = buffer.toString('utf8');
      } else {
        buffer = fs.readFileSync(absolutePath);
        if (isBinaryContent(buffer)) continue;
        content = buffer.toString('utf8');
      }
    } catch {
      continue;
    }

    if (!content) continue;

    findings.push(...scanContent(content, filePath));
  }

  if (findings.length === 0) {
    process.exit(0);
  }

  console.error('\nPotential secrets detected (fix before committing):');
  for (const finding of findings) {
    const location = finding.lineNumber ? `:${finding.lineNumber}` : '';
    console.error(`- ${finding.filePath}${location} — ${finding.pattern} (${finding.match})`);
  }
  console.error('\nIf you intended to include a fake example, add "secret-scan: allow" to that line.');
  process.exit(1);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) main();
