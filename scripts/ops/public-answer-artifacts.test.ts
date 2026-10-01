import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function walkJson(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJson(absolutePath);
    return entry.isFile() && entry.name.endsWith('.json') ? [absolutePath] : [];
  });
}

describe('public answer-bearing artifact boundary', () => {
  it('does not ship legacy static queues or raw answer flags under public/', () => {
    const staticQueueFiles = walkJson(path.join(ROOT, 'public', 'static-queues'))
      .map((filePath) => path.relative(ROOT, filePath));
    expect(staticQueueFiles).toEqual([]);

    const answerBearingJson = walkJson(path.join(ROOT, 'public'))
      .filter((filePath) => /"isCorrect"\s*:/.test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(ROOT, filePath));

    expect(answerBearingJson).toEqual([]);
    expect(fs.existsSync(
      path.join(ROOT, 'public', 'resources', 'CSD-Week-2-Answered.md'),
    )).toBe(false);
  });

  it('does not retain a generator, package task, or public-cache rule that can recreate them', () => {
    expect(fs.existsSync(
      path.join(ROOT, 'scripts', 'content', 'generate-static-queues.ts'),
    )).toBe(false);

    const packageJson = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const nextConfig = fs.readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');

    expect(packageJson).not.toContain('generate:static-queues');
    expect(nextConfig).not.toContain('/static-queues');
  });
});
