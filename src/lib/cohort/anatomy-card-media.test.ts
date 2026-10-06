import { describe, expect, it } from 'vitest';
import { anatomyCardMediaForStableId, REVIEWED_ANATOMY_MEDIA_STABLE_IDS } from './anatomy-card-media';

describe('reviewed anatomy card media registry', () => {
  it.each([
    ['cohort:anatomy:c-ccf1f2fc532f:v1', 'lateral-rectus'],
    ['cohort:anatomy:c-bf7970a915a8:v1', 'lateral-rectus'],
    ['cohort:anatomy:c-db24b4cc28af:v1', 'abducens'],
    ['cohort:anatomy:c-6b181def3d6b:v1', 'abducens'],
    ['cohort:anatomy:c-b268867d622e:v1', 'optic-nerve'],
    ['cohort:anatomy:c-ff128ba9fed0:v1', 'optic-nerve'],
  ])('points the visual card %s at its reviewed structure', (id, target) => {
    expect(anatomyCardMediaForStableId(id)?.target).toBe(target);
  });

  it.each([
    ['cohort:anatomy:c-684b1b98be79:v1', 'median-nerve'],
    ['cohort:anatomy:c-4282cc332060:v1', 'flexor-retinaculum'],
    ['cohort:anatomy:c-15e3963e7828:v1', 'trapezium'],
    ['cohort:anatomy:c-2a9d592a962f:v1', 'trapezoid'],
    ['cohort:anatomy:c-d1c8d35ea537:v1', 'capitate'],
    ['cohort:anatomy:c-6b1359a45b1f:v1', 'hamate'],
    ['cohort:anatomy:c-bf996fb12d2d:v1', 'median-nerve'],
    ['cohort:anatomy:c-aa0dbbbb964c:v1', 'flexor-retinaculum'],
    ['cohort:anatomy:c-26153cbb8a4b:v1', 'trapezium'],
    ['cohort:anatomy:c-4751dcc945eb:v1', 'trapezoid'],
    ['cohort:anatomy:c-e88e67c4dc0c:v1', 'capitate'],
    ['cohort:anatomy:c-e5041ed26e0b:v1', 'hamate'],
  ])('binds carpal card %s to its reviewed target', (id, target) => {
    expect(anatomyCardMediaForStableId(id)).toMatchObject({ figureId: 'carpal-tunnel-focus', target, role: 'prompt' });
  });

  it('maps the reviewed ocular and carpal cards explicitly', () => {
    expect(REVIEWED_ANATOMY_MEDIA_STABLE_IDS.filter(id => anatomyCardMediaForStableId(id)?.figureId === 'abducens-local')).toEqual([
      'cohort:anatomy:c-dd0bcce3d72d:v1',
      'cohort:anatomy:c-8dab68bbf8d1:v1',
      'cohort:anatomy:c-ccf1f2fc532f:v1',
      'cohort:anatomy:c-bf7970a915a8:v1',
      'cohort:anatomy:c-db24b4cc28af:v1',
      'cohort:anatomy:c-6b181def3d6b:v1',
      'cohort:anatomy:c-b268867d622e:v1',
      'cohort:anatomy:c-ff128ba9fed0:v1',
    ]);
    expect(REVIEWED_ANATOMY_MEDIA_STABLE_IDS).toHaveLength(20);
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-dd0bcce3d72d:v1')?.figureId).toBe('abducens-local');
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-000000000000:v1')).toBeUndefined();
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-dd0bcce3d72d:v1')?.preAnswerAlt).not.toMatch(/CN ?VI|sixth nerve/i);
  });
});
