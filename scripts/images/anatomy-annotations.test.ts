import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAnatomyAnnotations, writeAnatomyAnnotations } from './anatomy-annotations';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function chunk(kind: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(kind), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}
function png(width = 100, height = 80) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3), 0))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anatomy-annotations-')); roots.push(root);
  const bytes = png(); writeFileSync(join(root, 'base.png'), bytes);
  const review = { status: 'agent-reviewed', notes: 'Synthetic placement fixture only; no clinical acceptance.' };
  const spec = {
    schemaVersion: 1, id: 'placement-fixture',
    baseImage: { file: 'base.png', sha256: hash(bytes), width: 100, height: 80, review },
    regions: [
      { id: 'defect-rim', name: 'Synthetic rim mask', polygon: [[10, 10], [30, 10], [30, 30], [10, 30]],
        sources: [{ url: 'https://www.chop.edu/conditions-diseases/congenital-diaphragmatic-hernia-cdh', fact: 'A diaphragm defect is distinct from herniated bowel; these boxes are test geometry only.' }], review },
      { id: 'bowel', name: 'Synthetic bowel mask', polygon: [[40, 10], [60, 10], [60, 30], [40, 30]],
        sources: [{ url: 'https://www.chop.edu/conditions-diseases/congenital-diaphragmatic-hernia-cdh', fact: 'Bowel may herniate through a diaphragm defect; this mask is not anatomical.' }], review },
    ],
    labels: [{ id: 'defect-label', text: 'Defect rim', anchor: [20, 20], elbow: [20, 40], textPosition: [20, 55], targetRegion: 'defect-rim', align: 'start', fontSize: 12 }],
    title: { text: 'Test placement', position: [50, 6], align: 'middle', fontSize: 6 },
    footer: { text: 'Geometry fixture', position: [50, 75], align: 'middle', fontSize: 5 },
  };
  return { root, bytes, spec };
}

describe('deterministic anatomical annotation layer', () => {
  it('embeds the exact reviewed PNG and deterministic native labels, without altering input bytes', () => {
    const { root, bytes, spec } = fixture();
    const result = renderAnatomyAnnotations(spec, { rootDir: root });
    expect(result.svg).toContain(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(result.svg).toContain('points="20,20 20,40 20,55"');
    expect(result.svg).toContain('cx="20" cy="20"');
    expect(result.svg).toContain('<metadata>');
    expect(result.receipt.baseImage.sha256).toBe(hash(bytes));
    expect(result.receipt.anchorChecks).toEqual([{ labelId: 'defect-label', targetRegion: 'defect-rim', anchor: [20, 20], result: 'strict-interior' }]);
    expect(result.receipt.clinicalReviewStatus).toBe('not-established-by-this-tool');
    expect(result).toEqual(renderAnatomyAnnotations(spec, { rootDir: root }));
    expect(readFileSync(join(root, 'base.png'))).toEqual(bytes);
  });

  it('rejects a defect leader moved into bowel even though it is inside the canvas', () => {
    const { root, spec } = fixture(); spec.labels[0].anchor = [50, 20];
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/defect-label.*strictly inside.*defect-rim/);
  });

  it('keeps the returned receipt pinned if the caller subsequently edits the input specification', () => {
    const { root, spec } = fixture(); const rendered = renderAnatomyAnnotations(spec, { rootDir: root });
    const originalReceipt = JSON.stringify(rendered.receipt);
    spec.labels[0].anchor[0] = 50; spec.baseImage.review.notes = 'Changed after render';
    expect(JSON.stringify(rendered.receipt)).toBe(originalReceipt);
  });

  it.each([[10, 20], [10, 10], [10 + 1e-8, 20]])('rejects ambiguous polygon boundaries at %j', (x, y) => {
    const { root, spec } = fixture(); spec.labels[0].anchor = [x, y];
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/strictly inside/);
  });

  it('uses actual concave polygon membership, not its rectangular bounds', () => {
    const { root, spec } = fixture();
    spec.regions[0].polygon = [[10, 10], [30, 10], [30, 15], [15, 15], [15, 30], [10, 30]];
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/strictly inside/);
    spec.labels[0].anchor = [12, 20];
    expect(renderAnatomyAnnotations(spec, { rootDir: root }).receipt.anchorChecks).toHaveLength(1);
    spec.regions[0].polygon.reverse();
    expect(renderAnatomyAnnotations(spec, { rootDir: root }).receipt.anchorChecks).toHaveLength(1);
  });

  it('rejects changed base bytes even when the replacement is a valid same-size PNG', () => {
    const { root, spec, bytes } = fixture();
    const changed = Buffer.concat([bytes.subarray(0, -12), chunk('tEXt', Buffer.from('Changed\0yes')), bytes.subarray(-12)]);
    writeFileSync(join(root, 'base.png'), changed);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/SHA-256/);
  });

  it('rejects wrong dimensions and corrupt PNG chunks even with the supplied matching digest', () => {
    const { root, spec, bytes } = fixture(); spec.baseImage.width = 101;
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/dimensions/);
    spec.baseImage.width = 100;
    const damaged = Buffer.from(bytes); damaged[29] ^= 1;
    writeFileSync(join(root, 'base.png'), damaged); spec.baseImage.sha256 = hash(damaged);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*CRC/);
  });

  it('rejects a CRC-valid but undecodable PNG rather than producing an invisible base', () => {
    const { root, spec, bytes } = fixture();
    const broken = Buffer.concat([bytes.subarray(0, 33), chunk('IDAT', Buffer.from('not a zlib stream')), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(join(root, 'base.png'), broken); spec.baseImage.sha256 = hash(broken);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*(?:decode|scanline)/);
  });

  it('rejects unsupported PNG header methods even when the digest and CRC match', () => {
    const { root, spec, bytes } = fixture();
    const header = Buffer.from(bytes.subarray(16, 29)); header[10] = 7;
    const broken = Buffer.concat([bytes.subarray(0, 8), chunk('IHDR', header), bytes.subarray(33)]);
    writeFileSync(join(root, 'base.png'), broken); spec.baseImage.sha256 = hash(broken);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*header/);
  });

  it('accepts a valid Adam7 image while preserving the exact interlaced bytes', () => {
    const { root, spec, bytes } = fixture();
    const header = Buffer.from(bytes.subarray(16, 29)); header[12] = 1;
    // RGB8 100x80: seven Adam7 passes contain 400+370+760+1520+3020+6040+12040 bytes.
    const interlaced = Buffer.concat([bytes.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(24150))), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(join(root, 'base.png'), interlaced); spec.baseImage.sha256 = hash(interlaced);
    expect(renderAnatomyAnnotations(spec, { rootDir: root }).svg).toContain(interlaced.toString('base64'));
  });

  it.each(['short', 'long', 'filter'])('rejects incorrect decoded PNG scanlines: %s', mode => {
    const { root, spec, bytes } = fixture();
    const data = Buffer.alloc(24080 + (mode === 'short' ? -1 : mode === 'long' ? 1 : 0));
    if (mode === 'filter') data[0] = 5;
    const broken = Buffer.concat([bytes.subarray(0, 33), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(join(root, 'base.png'), broken); spec.baseImage.sha256 = hash(broken);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*scanline/);
  });

  it('rejects a missing indexed palette and unknown critical PNG chunks', () => {
    const { root, spec, bytes } = fixture();
    const header = Buffer.from(bytes.subarray(16, 29)); header[9] = 3;
    const broken = Buffer.concat([bytes.subarray(0, 8), chunk('IHDR', header), bytes.subarray(33)]);
    writeFileSync(join(root, 'base.png'), broken); spec.baseImage.sha256 = hash(broken);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*palette/);
    const unknown = Buffer.concat([bytes.subarray(0, -12), chunk('ABCD', Buffer.alloc(0)), bytes.subarray(-12)]);
    writeFileSync(join(root, 'base.png'), unknown); spec.baseImage.sha256 = hash(unknown);
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/PNG.*critical/);
  });

  it('places panel titles separately and validates their canvas positions', () => {
    const { root, spec } = fixture();
    const withHeading = { ...spec, textBlocks: [{ text: 'Patient right', position: [5, 35], align: 'start', fontSize: 5 }] };
    expect(renderAnatomyAnnotations(withHeading, { rootDir: root }).svg).toContain('Patient right');
    withHeading.textBlocks[0].position[0] = 101;
    expect(() => renderAnatomyAnnotations(withHeading, { rootDir: root })).toThrow(/textBlocks\[0\].position.*bounds/);
  });

  it.each(['../base.png', '/base.png', './base.png', 'sub/../base.png', 'sub\\base.png', 'file:///base.png'])('rejects unsafe base path %s', path => {
    const { root, spec } = fixture(); spec.baseImage.file = path;
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/safe relative path/);
  });

  it('rejects symlink inputs and symlink parents without writing anything', () => {
    const { root, spec } = fixture(); symlinkSync(join(root, 'base.png'), join(root, 'alias.png'));
    spec.baseImage.file = 'alias.png';
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/symlink/);
    symlinkSync(root, join(root, 'linked'), 'dir'); spec.baseImage.file = 'linked/base.png';
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/symlink/);
  });

  it.each(['base', 'region'])('rejects unreviewed %s geometry', target => {
    const { root, spec } = fixture();
    if (target === 'base') spec.baseImage.review = { status: 'draft', notes: 'Not inspected' };
    else spec.regions[0].review = { status: 'draft', notes: 'Not inspected' };
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/agent-reviewed/);
  });

  it.each([
    [[10, 10], [30, 30], [10, 30], [30, 10]],
    [[10, 10], [20, 20], [30, 30]],
    [[10, 10], [30, 10], [20, 10], [30, 30], [10, 30]],
    [[10, 10], [30, 10], [30, 30], [10, 10]],
    [[10, 10], [30, 10], [30, 30], [20, 10], [10, 30]],
  ].map(polygon => ({ polygon })))('rejects non-simple or degenerate polygon %#', ({ polygon }) => {
    const { root, spec } = fixture(); spec.regions[0].polygon = polygon;
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/polygon/);
  });

  it('rejects duplicate IDs, unknown regions, missing facts, and credential-bearing source URLs', () => {
    const { root, spec } = fixture();
    spec.regions[1].id = spec.regions[0].id;
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/duplicate/);
    spec.regions[1].id = 'bowel'; spec.labels[0].targetRegion = 'missing';
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/unknown targetRegion/);
    spec.labels[0].targetRegion = 'defect-rim'; spec.regions[0].sources[0].fact = '';
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/fact/);
    spec.regions[0].sources[0].fact = 'Test'; spec.regions[0].sources[0].url = 'https://secret@example.org/paper';
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/source URL/);
  });

  it.each([NaN, Infinity, -1, 101])('rejects invalid coordinates %s', x => {
    const { root, spec } = fixture(); spec.labels[0].elbow[0] = x;
    expect(() => renderAnatomyAnnotations(spec, { rootDir: root })).toThrow(/bounds/);
  });

  it('rejects unknown properties and escapes strings instead of executing SVG markup', () => {
    const { root, spec } = fixture();
    expect(() => renderAnatomyAnnotations({ ...spec, clinicalApproval: true }, { rootDir: root })).toThrow(/unknown property/);
    spec.labels[0].text = '<script>alert("x")</script> & rim';
    const result = renderAnatomyAnnotations(spec, { rootDir: root });
    expect(result.svg).not.toContain('<script>');
    expect(result.svg).toContain('&lt;script&gt;');
    expect(result.svg).not.toMatch(/<image[^>]+href="https:/);
  });

  it('writes SVG and receipt only after validation; never overwrites an input or follows output symlinks', () => {
    const { root, spec, bytes } = fixture();
    writeFileSync(join(root, 'spec.json'), JSON.stringify(spec));
    const result = writeAnatomyAnnotations('spec.json', 'result.svg', { rootDir: root });
    expect(readFileSync(join(root, 'result.svg'), 'utf8')).toBe(result.svg);
    expect(JSON.parse(readFileSync(join(root, 'result.svg.checks.json'), 'utf8'))).toEqual(result.receipt);
    expect(() => writeAnatomyAnnotations('spec.json', 'spec.json', { rootDir: root })).toThrow();
    symlinkSync(join(root, 'base.png'), join(root, 'linked.svg'));
    expect(() => writeAnatomyAnnotations('spec.json', 'linked.svg', { rootDir: root })).toThrow(/symlink/);
    spec.labels[0].anchor = [50, 20]; writeFileSync(join(root, 'spec.json'), JSON.stringify(spec));
    expect(() => writeAnatomyAnnotations('spec.json', 'new/result.svg', { rootDir: root })).toThrow(/strictly inside/);
    expect(existsSync(join(root, 'new'))).toBe(false);
    expect(readFileSync(join(root, 'base.png'))).toEqual(bytes);
  });

  it('rejects linked receipts before replacing an existing SVG and refuses hardlinked outputs', () => {
    const { root, spec, bytes } = fixture(); writeFileSync(join(root, 'spec.json'), JSON.stringify(spec));
    writeFileSync(join(root, 'result.svg'), 'existing output');
    symlinkSync(join(root, 'base.png'), join(root, 'result.svg.checks.json'));
    expect(() => writeAnatomyAnnotations('spec.json', 'result.svg', { rootDir: root })).toThrow(/symlink/);
    expect(readFileSync(join(root, 'result.svg'), 'utf8')).toBe('existing output');
    linkSync(join(root, 'base.png'), join(root, 'hardlinked.svg'));
    expect(() => writeAnatomyAnnotations('spec.json', 'hardlinked.svg', { rootDir: root })).toThrow(/hard links/);
    expect(readFileSync(join(root, 'base.png'))).toEqual(bytes);
  });
});
