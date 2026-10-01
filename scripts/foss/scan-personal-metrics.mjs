#!/usr/bin/env node
/**
 * Surface candidate personal-data leaks in the MIT distribution.
 *
 * ADVISORY, NOT A GATE — and deliberately so. `scripts/foss/distribution.ts`
 * screens distributed files with NAME patterns, which is a precise test and
 * correctly blocks the build. The leak class this looks for has no name in it:
 * a comment stating one learner's study rate or grade distribution as the
 * justification for a design decision. See
 * .claude/rules/foss-manifest-ships-people-not-just-names.md for the three
 * instances found on 2026-09-11, two of which the gate passed clean.
 *
 * Measured precision on the real tree when this was written: 4 hits across
 * 1,884 distributed files, of which 1 was a genuine leak, 1 borderline and 2
 * legitimate (a corpus property and a capacity calculation). That is useful to
 * a human reading four lines; it is nowhere near good enough to fail a release
 * on, and a guard that fires on correct behaviour gets switched off
 * (.claude/rules/repetition-guards.md). So this prints and exits 0.
 *
 *   node scripts/foss/scan-personal-metrics.mjs             # whole manifest
 *   node scripts/foss/scan-personal-metrics.mjs --changed    # your work, vs origin/main
 *   node scripts/foss/scan-personal-metrics.mjs <paths...>   # just these
 *
 * `--changed` is the one to reach for, because the risk attaches to the COMMENT
 * YOU WROTE, not to whether the path is new. Adding a path to the manifest is
 * the obvious case and the rarer one; adding a paragraph to a file already in
 * the manifest is the common one, and nothing prompts you to think about the
 * distribution at all. It intersects your changed files with the manifest, so
 * you do not have to know which files ship.
 *
 * Every hit is a question, not a verdict: does this sentence describe the
 * software, or the person who uses it?
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MANIFEST = 'foss/distribution-paths.txt';

/**
 * Each pattern targets prose that states a usage magnitude. They intentionally
 * over-match: a false positive costs one glance, a miss ships someone's study
 * record to strangers.
 */
const PATTERNS = [
  {
    name: 'rate-per-day',
    re: /\b(?:graded|grades|reviewed|reviews|studied|studies|answered|answers|cards)\b[^.\n]{0,40}\b(?:per|a|each)\s+day\b/i,
    asks: 'a rate — is it this deployment, or one person?',
  },
  {
    name: 'share-of-study-items',
    re: /\b\d+(?:\.\d+)?\s*%\s*of\s+(?:his|her|their|the\s+)?(?:card|grade|review|answer|item|topic)/i,
    asks: 'a proportion — whose behaviour is it measuring?',
  },
  {
    name: 'n-of-m-study-items',
    re: /\b\d{1,3}(?:,\d{3})*\s+of\s+\d{1,3}(?:,\d{3})*\s+(?:cards?|grades?|reviews?|topics?|squares?)\b/i,
    asks: 'a count out of a total — a corpus fact, or a performance record?',
  },
];

function manifestPaths() {
  return fs.readFileSync(MANIFEST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

const args = process.argv.slice(2);
const wantsChanged = args.includes('--changed');
const targets = args.filter((a) => !a.startsWith('--'));
const manifest = new Set(manifestPaths());

/**
 * Files this branch has touched that actually ship. Compared against the merge
 * base so a long-lived branch reports its own work rather than everything that
 * has landed on the trunk meanwhile. Falls back to the whole manifest if git
 * cannot answer — a scan of everything is a worse experience, never a wrong one.
 */
function changedDistributedPaths() {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  let base;
  try {
    base = git(['merge-base', 'HEAD', 'origin/main']);
  } catch {
    base = 'HEAD';
  }
  const names = new Set();
  for (const range of [['diff', '--name-only', base, 'HEAD'], ['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    try {
      for (const line of git(range).split('\n')) if (line.trim()) names.add(line.trim());
    } catch {
      // a missing origin/main or an empty range is not an error here
    }
  }
  return [...names].filter((n) => manifest.has(n));
}

let paths;
if (wantsChanged) {
  paths = changedDistributedPaths();
  if (paths.length === 0) {
    console.log('No files you have changed are in the MIT distribution. Nothing to check.');
    process.exit(0);
  }
  console.log(`Checking ${paths.length} changed file(s) that ship in the distribution.\n`);
} else {
  paths = targets.length > 0 ? targets : manifestPaths();
}

let scanned = 0;
const hits = [];

for (const path of paths) {
  let source;
  try {
    source = fs.readFileSync(path, 'utf8');
  } catch {
    continue; // a manifest entry can name a file this checkout does not have
  }
  scanned += 1;

  source.split('\n').forEach((line, i) => {
    for (const { name, re, asks } of PATTERNS) {
      const match = line.match(re);
      if (match) hits.push({ path, line: i + 1, name, asks, text: match[0].trim() });
    }
  });
}

if (targets.length > 0) {
  const unlisted = targets.filter((p) => !manifest.has(p));
  if (unlisted.length > 0) {
    console.log(`Note: not in ${MANIFEST} (so not shipped yet): ${unlisted.join(', ')}\n`);
  }
}

for (const hit of hits) {
  console.log(`${hit.path}:${hit.line}  [${hit.name}]`);
  console.log(`    ${hit.text.slice(0, 120)}`);
  console.log(`    → ${hit.asks}\n`);
}

console.log(
  hits.length === 0
    ? `No usage-magnitude prose found in ${scanned} file(s).`
    : `${hits.length} line(s) to read in ${scanned} file(s). Each is a question, not a verdict.`,
);
console.log('Advisory only — this never fails a build. The gate screens NAMES; this screens for the person behind them.');
