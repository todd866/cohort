import { describe, expect, it } from 'vitest';
import cdh from './anatomy-scaffolds/left-cdh.json';
import { renderAnatomyScaffold, validateAnatomyScaffold } from './anatomy-scaffold';

describe('checked anatomical topology construction', () => {
  it('renders the reviewed relationships with explicit view and MIT provenance', () => {
    const report = validateAnatomyScaffold(cdh);
    expect(report.checks.length).toBeGreaterThanOrEqual(10);
    const rendered = renderAnatomyScaffold(cdh, 'paper');
    expect(rendered.svg).toContain('Frontal occupancy map');
    expect(rendered.svg).toContain('Caudal view');
    expect(rendered.svg).toContain('MIT');
    expect(rendered.svg).toContain('not a section');
    expect(rendered.geometrySha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('allows palette variation while keeping the complete geometry fixed', () => {
    const plain = renderAnatomyScaffold(cdh, 'paper');
    const contrast = renderAnatomyScaffold(cdh, 'contrast');
    expect(plain.svg).not.toBe(contrast.svg);
    expect(plain.geometrySha256).toBe(contrast.geometrySha256);
  });
  it.each([
    ['laterality', (s: any) => { s.views[1].patientRight = 'viewer-right'; }],
    ['lung overlap', (s: any) => { s.regions.find((r: any) => r.id === 'cdh-left-lung').parts[0].y = 140; }],
    ['disconnected bowel', (s: any) => { s.regions.find((r: any) => r.id === 'cdh-bowel').parts[1].x = 215; }],
    ['intact diaphragm', (s: any) => { s.boundaries.find((b: any) => b.id === 'cdh-diaphragm').opening = [300, 320]; }],
    ['wrong shift', (s: any) => { s.regions.find((r: any) => r.id === 'cdh-mediastinum').parts[0].x = 200; }],
    ['moved midline', (s: any) => { s.views[1].midline = 190; }],
    ['misplaced label', (s: any) => { s.labels.find((l: any) => l.target === 'cdh-left-lung').anchor = [60, 100]; }],
    ['wrong posterior side', (s: any) => { s.locationMap.defect.center = [75, 65]; }],
    ['missing evidence', (s: any) => { s.sources = []; }],
    ['negative aperture radius', (s: any) => { s.locationMap.defect.radii = [-24, 25]; }],
    ['non-finite inset geometry', (s: any) => { s.locationMap.radii[0] = Infinity; }],
    ['baseline bowel in thorax', (s: any) => {
      s.regions.find((r: any) => r.id === 'baseline-bowel').parts[0].y = 130;
      s.labels.find((l: any) => l.target === 'baseline-bowel').anchor = [255, 180];
    }],
    ['corner-only bowel connection', (s: any) => {
      const r = s.regions.find((r: any) => r.id === 'cdh-bowel');
      r.parts[1] = { x: 270, y: 225, width: 35, height: 115 };
      r.parts[2] = { x: 305, y: 340, width: 20, height: 90 };
      s.labels.find((l: any) => l.target === 'cdh-bowel' && l.anchor[1] > 300).anchor = [315, 390];
    }],
    ['split rectangles cross intact diaphragm', (s: any) => {
      s.regions.find((r: any) => r.id === 'cdh-bowel').parts.push(
        { x: 220, y: 225, width: 55, height: 60 },
        { x: 220, y: 285, width: 55, height: 60 },
      );
    }],
  ])('rejects a clinically meaningful construction error: %s', (_name, mutate) => {
    const draft = structuredClone(cdh); mutate(draft);
    expect(() => validateAnatomyScaffold(draft)).toThrow();
    expect(() => renderAnatomyScaffold(draft, 'paper')).toThrow();
  });
});
