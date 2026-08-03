import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSeedQuestionCorpus } from '../../src/lib/question-bank/load-seed-corpus';
import {
  loadSeedOpenCorpusEnvironment,
  parseSeedOpenCorpusArgs,
  seedOpenCorpusAtomically,
  type OpenCorpusSeedTransactionClient,
  type OpenCorpusSeedTransactionHost,
} from './seed-open-corpus';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function corpus(...ids: string[]): LoadedSeedQuestionCorpus {
  return {
    files: [],
    errors: [],
    questions: ids.map((id) => ({ id }) as never),
  };
}

describe('parseSeedOpenCorpusArgs', () => {
  it('defaults to the explicit live mode and accepts the exact dry-run flag', () => {
    expect(parseSeedOpenCorpusArgs([])).toEqual({ dryRun: false });
    expect(parseSeedOpenCorpusArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('rejects unknown flags instead of falling through to a live write', () => {
    expect(() => parseSeedOpenCorpusArgs(['--dry-rn'])).toThrow(/unknown argument/i);
    expect(() => parseSeedOpenCorpusArgs(['--write'])).toThrow(/unknown argument/i);
  });
});

describe('open-corpus seed environment', () => {
  it('loads .env.local before .env without mutating the real process environment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-open-seed-env-'));
    temporaryRoots.push(root);
    fs.writeFileSync(
      path.join(root, '.env.local'),
      'DATABASE_URL=postgresql://local@localhost/local\nLOCAL_ONLY=yes\n',
    );
    fs.writeFileSync(
      path.join(root, '.env'),
      'DATABASE_URL=postgresql://fallback@localhost/fallback\nFALLBACK_ONLY=yes\n',
    );
    const target: NodeJS.ProcessEnv = {};

    loadSeedOpenCorpusEnvironment(root, target);

    expect(target).toMatchObject({
      DATABASE_URL: 'postgresql://local@localhost/local',
      LOCAL_ONLY: 'yes',
      FALLBACK_ONLY: 'yes',
    });
  });

  it('preserves an explicit shell DATABASE_URL over either env file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-open-seed-shell-env-'));
    temporaryRoots.push(root);
    fs.writeFileSync(
      path.join(root, '.env.local'),
      'DATABASE_URL=postgresql://local@localhost/local\n'
      + 'DATABASE_URL_LOCAL=postgresql://mirror@localhost/mirror\n',
    );
    fs.writeFileSync(
      path.join(root, '.env'),
      'DATABASE_URL=postgresql://fallback@localhost/fallback\n',
    );
    const target: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://shell@localhost/shell',
      DATABASE_URL_LOCAL: '',
    };

    loadSeedOpenCorpusEnvironment(root, target);

    expect(target.DATABASE_URL).toBe('postgresql://shell@localhost/shell');
    expect(target.DATABASE_URL_LOCAL).toBe('');
  });
});

describe('atomic open-corpus seed', () => {
  it('computes and enforces the stale-row guard before the first write', async () => {
    const events: string[] = [];
    const transaction: OpenCorpusSeedTransactionClient = {
      $executeRawUnsafe: vi.fn(async () => {
        events.push('raw-write');
        return 1;
      }),
      question: {
        findMany: vi.fn(async () => {
          events.push('read-existing');
          return [
            { id: 'current', contentState: 'enhanced' },
            { id: 'stale-1', contentState: 'enhanced' },
            { id: 'stale-2', contentState: 'enhanced' },
            { id: 'stale-3', contentState: 'enhanced' },
          ];
        }),
        updateMany: vi.fn(async () => {
          events.push('retire-write');
          return { count: 3 };
        }),
      },
    };
    const host: OpenCorpusSeedTransactionHost = {
      $transaction: async (operation) => operation(transaction),
    };
    const upsert = vi.fn(async () => {
      events.push('upsert-write');
      return { upserted: 1 };
    });

    await expect(seedOpenCorpusAtomically(host, corpus('current'), { upsert }))
      .rejects.toThrow(/Refusing to retire 3\/4/);

    expect(events).toEqual(['read-existing']);
    expect(upsert).not.toHaveBeenCalled();
    expect(transaction.question.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back completed upsert batches when a later retirement fails', async () => {
    let persisted = ['before-seed'];
    const events: string[] = [];
    const host: OpenCorpusSeedTransactionHost = {
      async $transaction<T>(operation: (
        transaction: OpenCorpusSeedTransactionClient,
      ) => Promise<T>): Promise<T> {
        const working = [...persisted];
        const transaction: OpenCorpusSeedTransactionClient = {
          $executeRawUnsafe: vi.fn(async () => 1),
          question: {
            findMany: vi.fn(async () => {
              events.push('read-existing');
              return [
                { id: 'current', contentState: 'enhanced' },
                { id: 'stale', contentState: 'enhanced' },
              ];
            }),
            updateMany: vi.fn(async () => {
              events.push('retire-write');
              working.push('retired-stale');
              throw new Error('injected retirement failure');
            }),
          },
        };
        const result = await operation(transaction);
        persisted = working;
        return result;
      },
    };
    const upsert = vi.fn(async (transaction: OpenCorpusSeedTransactionClient) => {
      events.push('upsert-write');
      await transaction.$executeRawUnsafe('synthetic upsert');
      return { upserted: 1 };
    });

    await expect(seedOpenCorpusAtomically(host, corpus('current'), { upsert }))
      .rejects.toThrow(/injected retirement failure/);

    expect(events).toEqual(['read-existing', 'upsert-write', 'retire-write']);
    expect(persisted).toEqual(['before-seed']);
  });
});
