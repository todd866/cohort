import { describe, expect, it } from 'vitest';
import {
  parseServingDbPreflightArgs,
  publicUsmleServingDbWhere,
  servingDatabaseTarget,
} from './check-serving-db';

describe('parseServingDbPreflightArgs', () => {
  it('parses safe output modes', () => {
    expect(parseServingDbPreflightArgs([])).toEqual({ json: false, out: null });
    expect(parseServingDbPreflightArgs(['--json', '--out=/tmp/report.json'])).toEqual({
      json: true,
      out: '/tmp/report.json',
    });
  });

  it('rejects unknown or incomplete arguments', () => {
    expect(() => parseServingDbPreflightArgs(['--write'])).toThrow(/unknown argument/i);
    expect(() => parseServingDbPreflightArgs(['--out'])).toThrow(/requires a value/i);
    expect(() => parseServingDbPreflightArgs(['--out='])).toThrow(/requires a value/i);
  });

  it('labels the selected database without exposing its URL', () => {
    expect(servingDatabaseTarget({ DATABASE_URL_LOCAL: 'postgresql://localhost/md3' }))
      .toBe('local-mirror');
    expect(servingDatabaseTarget({ DATABASE_URL_LOCAL: '' })).toBe('configured-database');
    expect(servingDatabaseTarget({})).toBe('configured-database');
  });

  it('loads expected rows plus unexpected active rows owned by the open corpus', () => {
    expect(publicUsmleServingDbWhere(['released-1'])).toEqual({
      OR: [
        { id: { in: ['released-1'] } },
        {
          source: 'bank',
          sourceFile: { startsWith: 'open-content/usmle/step1/' },
          moduleNodes: { has: 'usmle/step1' },
          excluded: false,
          contentState: { in: ['validated', 'enhanced', 'cited', 'production'] },
        },
      ],
    });
  });
});
