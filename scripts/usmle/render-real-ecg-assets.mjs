#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const RECORDED_ECG_RENDER_VERSION = 'recorded-ecg-svg-v1';

export const RECORDED_ECG_ASSETS = [
  {
    assetId: 'ecg-case-2w7m4q',
    input: '07793_hr.dat',
    sourceSha256: '74f3abc68ef093f5428bc317ae55088940b47c7fb0d8cbcaeb83d092ef439552',
    channels: 12,
    channel: 1,
    sampleRate: 500,
    startSeconds: 3.2,
    durationSeconds: 4,
    lead: 'II',
    verticalRangePx: 165,
    marker: {
      label: 'X',
      seconds: 1.916,
      validation: 'local-absolute-peak',
      validationWindowSeconds: 0.2,
    },
  },
  {
    assetId: 'ecg-case-4n8k2p',
    input: '08048_hr.dat',
    sourceSha256: '9f5422b5a435c55a4bebd7eb56dc2dd038742bb3f2b3a7af16326cf12e95ea26',
    channels: 12,
    channel: 1,
    sampleRate: 500,
    startSeconds: 0.35,
    durationSeconds: 8.9,
    lead: 'II',
    verticalRangePx: 150,
  },
  {
    assetId: 'ecg-case-6r3t9x',
    input: '00330_hr.dat',
    sourceSha256: '77f28d5bd7b00d7439289e57f7482449a41b8f97649a48aeb1cd548bf727b8ea',
    channels: 12,
    channel: 1,
    sampleRate: 500,
    startSeconds: 0.2,
    durationSeconds: 6,
    lead: 'II',
    verticalRangePx: 155,
  },
  {
    assetId: 'ecg-case-8v5c2h',
    input: '022448_0120.dat',
    sourceSha256: 'a5bc1fe476356d1eab6a5b91810711e6d1f12b3bdc82e936a8ccb7e7e71ed442',
    channels: 5,
    channel: 0,
    sampleRate: 250,
    startSeconds: 300,
    durationSeconds: 6,
    lead: 'II',
    verticalRangePx: 155,
  },
  {
    assetId: 'ecg-case-9q4d7m',
    input: '00959_hr.dat',
    sourceSha256: 'd03bba71dbf4e1c47ec9e3b2e07964c00692663f366268bfd5eae2bc2ee060ce',
    channels: 12,
    channel: 1,
    sampleRate: 500,
    startSeconds: 0.35,
    durationSeconds: 9,
    lead: 'II',
    verticalRangePx: 110,
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quantile(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round(proportion * (sorted.length - 1))),
  );
  return sorted[index];
}

function readFormat16(inputPath, channels, channel) {
  const bytes = fs.readFileSync(inputPath);
  if (bytes.length % (channels * 2) !== 0) {
    throw new Error(`${inputPath} is not an interleaved WFDB format-16 signal`);
  }
  const frameCount = bytes.length / (channels * 2);
  const values = new Float64Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    values[index] = bytes.readInt16LE((index * channels + channel) * 2);
  }
  return values;
}

function renderSvg(spec, sourceDir) {
  const inputPath = path.join(sourceDir, spec.input);
  const sourceBytes = fs.readFileSync(inputPath);
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== spec.sourceSha256) {
    throw new Error(
      `${spec.input} hash mismatch: expected ${spec.sourceSha256}, got ${actualSourceSha256}`,
    );
  }

  const allValues = readFormat16(inputPath, spec.channels, spec.channel);
  const firstSample = Math.round(spec.startSeconds * spec.sampleRate);
  const finalSample = Math.round(
    (spec.startSeconds + spec.durationSeconds) * spec.sampleRate,
  );
  if (firstSample < 0 || finalSample > allValues.length || firstSample >= finalSample) {
    throw new Error(`${spec.assetId} excerpt lies outside ${spec.input}`);
  }
  const values = Array.from(allValues.slice(firstSample, finalSample));
  const baseline = quantile(values, 0.5);
  const low = quantile(values, 0.01);
  const high = quantile(values, 0.99);
  const amplitude = Math.max(1, high - low);

  if (spec.marker?.validation === 'local-absolute-peak') {
    const markerIndex = Math.round(spec.marker.seconds * spec.sampleRate);
    const radius = Math.round(spec.marker.validationWindowSeconds * spec.sampleRate);
    if (markerIndex - radius < 0 || markerIndex + radius >= values.length) {
      throw new Error(`${spec.assetId} marker validation window lies outside the excerpt`);
    }
    let localPeakIndex = markerIndex - radius;
    let localPeakAmplitude = -1;
    for (let index = markerIndex - radius; index <= markerIndex + radius; index += 1) {
      const candidateAmplitude = Math.abs(values[index] - baseline);
      if (candidateAmplitude > localPeakAmplitude) {
        localPeakAmplitude = candidateAmplitude;
        localPeakIndex = index;
      }
    }
    if (localPeakIndex !== markerIndex) {
      throw new Error(
        `${spec.assetId} marker is not the local absolute waveform peak: `
        + `expected sample ${markerIndex}, found ${localPeakIndex}`,
      );
    }
  }

  const left = 54;
  const right = 930;
  const top = 86;
  const bottom = 306;
  const maxPoints = 2_500;
  const stride = Math.max(1, Math.ceil(values.length / maxPoints));
  const points = [];
  for (let index = 0; index < values.length; index += stride) {
    const x = left + (index / Math.max(1, values.length - 1)) * (right - left);
    const normalized = (values[index] - baseline) / amplitude;
    const y = (top + bottom) / 2 - normalized * spec.verticalRangePx;
    points.push(
      `${x.toFixed(2)},${Math.max(top - 18, Math.min(bottom + 18, y)).toFixed(2)}`,
    );
  }

  const smallGridPx = (right - left) / (spec.durationSeconds / 0.04);
  const majorGridPx = smallGridPx * 5;
  const marker = spec.marker
    ? (() => {
      const x = left + (spec.marker.seconds / spec.durationSeconds) * (right - left);
      return `\n  <rect x="${(x - 18).toFixed(2)}" y="76" width="36" height="236" rx="8" fill="none" stroke="#8752a6" stroke-width="2" stroke-dasharray="6 5"/>\n  <text x="${x.toFixed(2)}" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="23" font-weight="800" fill="#6b358d">${spec.marker.label}</text>`;
    })()
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360" role="img">
  <title>Recorded ECG excerpt</title>
  <desc>De-identified recorded ECG waveform excerpt rendered from an open clinical dataset.</desc>
  <defs>
    <pattern id="smallGrid" width="${smallGridPx.toFixed(3)}" height="${smallGridPx.toFixed(3)}" patternUnits="userSpaceOnUse"><path d="M ${smallGridPx.toFixed(3)} 0 L 0 0 0 ${smallGridPx.toFixed(3)}" fill="none" stroke="#f4c8cf" stroke-width="0.45"/></pattern>
    <pattern id="grid" width="${majorGridPx.toFixed(3)}" height="${majorGridPx.toFixed(3)}" patternUnits="userSpaceOnUse"><rect width="${majorGridPx.toFixed(3)}" height="${majorGridPx.toFixed(3)}" fill="url(#smallGrid)"/><path d="M ${majorGridPx.toFixed(3)} 0 L 0 0 0 ${majorGridPx.toFixed(3)}" fill="none" stroke="#e99aa7" stroke-width="0.8"/></pattern>
  </defs>
  <rect width="960" height="360" fill="#fffafa"/>
  <text x="480" y="42" text-anchor="middle" font-family="system-ui, sans-serif" font-size="19" font-weight="700" fill="#26323f">Recorded ECG · Lead ${spec.lead}</text>
  <rect x="40" y="62" width="900" height="264" rx="12" fill="url(#grid)" stroke="#df7180" stroke-width="1"/>
  <polyline points="${points.join(' ')}" fill="none" stroke="#163d63" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/>${marker}
  <text x="62" y="318" font-family="system-ui, sans-serif" font-size="12" fill="#343b45">25 mm/s · ${spec.durationSeconds.toFixed(1)} s recorded excerpt · amplitude normalized</text>
</svg>\n`;
}

function renderParameters(spec) {
  const parameters = Object.fromEntries(Object.entries(spec).filter(([key]) => (
    key !== 'assetId' && key !== 'input' && key !== 'sourceSha256'
  )));
  return { renderVersion: RECORDED_ECG_RENDER_VERSION, ...parameters };
}

export function renderRecordedEcgAssets({ sourceDir, check = false }) {
  const results = [];
  for (const spec of RECORDED_ECG_ASSETS) {
    const svg = renderSvg(spec, sourceDir);
    const outputSha256 = sha256(svg);
    const parametersDigest = sha256(JSON.stringify(renderParameters(spec)));
    const canonicalPath = path.join(
      ROOT,
      'open-content/usmle/step1/media',
      `${spec.assetId}.svg`,
    );
    const publicPath = path.join(ROOT, 'public/figures/usmle/step1', `${spec.assetId}.svg`);

    if (check) {
      for (const outputPath of [canonicalPath, publicPath]) {
        const existing = fs.readFileSync(outputPath, 'utf8');
        if (existing !== svg) throw new Error(`${outputPath} is stale; rerun the renderer`);
      }
    } else {
      fs.writeFileSync(canonicalPath, svg);
      fs.writeFileSync(publicPath, svg);
    }

    results.push({
      assetId: spec.assetId,
      outputSha256: `sha256:${outputSha256}`,
      sourceSha256: `sha256:${spec.sourceSha256}`,
      parametersDigest: `sha256:${parametersDigest}`,
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sourceDirIndex = process.argv.indexOf('--source-dir');
  const sourceDir = sourceDirIndex >= 0 ? process.argv[sourceDirIndex + 1] : undefined;
  if (!sourceDir) {
    throw new Error('Usage: render-real-ecg-assets.mjs --source-dir PATH [--check]');
  }
  console.log(JSON.stringify(
    renderRecordedEcgAssets({ sourceDir, check: process.argv.includes('--check') }),
    null,
    2,
  ));
}
