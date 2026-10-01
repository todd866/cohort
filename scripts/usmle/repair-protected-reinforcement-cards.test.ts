import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  parseRepairProtectedReinforcementArgs,
  protectedReinforcementCandidatesSql,
  reinforcementDatabaseTarget,
  repairProtectedReinforcementCards,
  type RepairProtectedReinforcementClient,
} from './repair-protected-reinforcement-cards';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from '../../src/lib/usmle/public-release-bundle';

function mockClient(candidates: Array<{ id: string; stableId: string | null; rotation: string }>) {
  const client: RepairProtectedReinforcementClient = {
    $queryRaw: vi.fn().mockResolvedValue(candidates) as unknown as <T>(query: Prisma.Sql) => Promise<T>,
    card: { updateMany: vi.fn().mockResolvedValue({ count: candidates.length }) },
  };
  return client;
}

describe('protected reinforcement repair', () => {
  it('defaults to a read-only audit and accepts explicit apply/json modes', () => {
    expect(parseRepairProtectedReinforcementArgs([])).toEqual({ apply: false, json: false });
    expect(parseRepairProtectedReinforcementArgs(['--json', '--apply'])).toEqual({
      apply: true,
      json: true,
    });
    expect(() => parseRepairProtectedReinforcementArgs(['--delete'])).toThrow(/unknown argument/i);
  });

  it('labels the selected database without exposing its URL', () => {
    expect(reinforcementDatabaseTarget({ DATABASE_URL_LOCAL: 'postgresql://localhost/md3' }))
      .toBe('local-mirror');
    expect(reinforcementDatabaseTarget({ DATABASE_URL_LOCAL: '' }))
      .toBe('configured-database');
    expect(reinforcementDatabaseTarget({})).toBe('configured-database');
  });

  it('finds both linked primary cards and relationless stableId fact siblings by canonical parent identity', () => {
    const sql = protectedReinforcementCandidatesSql.strings.join(' ');
    expect(sql).toContain('q."cardId" = c.id');
    expect(sql).toContain("c.\"stableId\" = 'qcard:' || q.id");
    expect(sql).toContain("strpos(c.\"stableId\", 'qcard:' || q.id || ':fact:') = 1");
    expect(sql).toContain("c.\"stableId\" LIKE 'qcard:%'");
    expect(sql).toContain("q.rotation = 'usmle-step1'");
    expect(sql).toContain("'usmle/step1' = ANY(q.\"moduleNodes\")");
    expect(sql).toContain('c."deletedAt" IS NULL');
  });

  it('keeps a released parent protected even after its routing fields drift', () => {
    const releasedId = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS][0];
    const sql = protectedReinforcementCandidatesSql.strings.join(' ');

    expect(sql).toContain('q.id IN (');
    expect(protectedReinforcementCandidatesSql.values).toContain(releasedId);
  });

  it('matches orphaned released primary and fact stable ids without a Question row', () => {
    const releasedId = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS][0];

    expect(protectedReinforcementCandidatesSql.values).toContain(`qcard:${releasedId}`);
    expect(protectedReinforcementCandidatesSql.values).toContain(`qcard:${releasedId}:fact:`);
  });

  it('reports candidates without mutating in default dry-run mode', async () => {
    const client = mockClient([
      { id: 'fact-card', stableId: 'qcard:q-cross:fact:f1', rotation: 'cardiology' },
    ]);

    const report = await repairProtectedReinforcementCards(client, { apply: false });

    expect(report).toMatchObject({
      mode: 'dry-run',
      candidateCount: 1,
      retiredCount: 0,
    });
    expect(client.card.updateMany).not.toHaveBeenCalled();
  });

  it('soft-deletes the audited IDs idempotently only in explicit apply mode', async () => {
    const client = mockClient([
      { id: 'primary-card', stableId: 'qcard:q-primary', rotation: 'usmle-step1' },
      { id: 'fact-card', stableId: 'qcard:q-cross:fact:f1', rotation: 'cardiology' },
    ]);
    const now = new Date('2026-08-01T00:00:00.000Z');

    const report = await repairProtectedReinforcementCards(client, { apply: true, now });

    expect(report).toMatchObject({ mode: 'apply', candidateCount: 2, retiredCount: 2 });
    expect(client.card.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['primary-card', 'fact-card'] }, deletedAt: null },
      data: { deletedAt: now },
    });
  });
});
