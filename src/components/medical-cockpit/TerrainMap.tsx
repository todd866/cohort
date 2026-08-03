'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { PatientState, Syndrome } from '@/lib/medical-cockpit';
import { getDerivedState, getSeverityZ } from '@/lib/medical-cockpit';
import { clamp } from '@/lib/utils/clamp';

type ColorStop = { t: number; r: number; g: number; b: number };

const SEVERITY_STOPS: ColorStop[] = [
  { t: 0.0, r: 45, g: 106, b: 79 }, // safe green
  { t: 0.3, r: 149, g: 213, b: 178 }, // light green
  { t: 0.55, r: 255, g: 209, b: 102 }, // yellow
  { t: 0.75, r: 239, g: 71, b: 111 }, // red-pink
  { t: 0.9, r: 208, g: 0, b: 0 }, // red
  { t: 1.0, r: 55, g: 6, b: 23 }, // near-black
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorForSeverity(t: number): { r: number; g: number; b: number } {
  const clamped = clamp(t, 0, 1);
  const idx = SEVERITY_STOPS.findIndex((s) => clamped <= s.t);
  if (idx <= 0) return SEVERITY_STOPS[0];
  const hi = SEVERITY_STOPS[idx];
  const lo = SEVERITY_STOPS[idx - 1];
  const span = hi.t - lo.t || 1;
  const localT = (clamped - lo.t) / span;
  return {
    r: Math.round(lerp(lo.r, hi.r, localT)),
    g: Math.round(lerp(lo.g, hi.g, localT)),
    b: Math.round(lerp(lo.b, hi.b, localT)),
  };
}

function stateAtMap(pulsePressure: number, map: number): { sbp: number; dbp: number } {
  const pp = clamp(Number.isFinite(pulsePressure) ? pulsePressure : 40, 20, 80);
  const dbp = map - pp / 3;
  const sbp = dbp + pp;
  return { sbp, dbp };
}

function normalize3(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const mag = Math.hypot(x, y, z) || 1;
  return { x: x / mag, y: y / mag, z: z / mag };
}

function dot3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

type TerrainGrid = {
  width: number;
  height: number;
  z: Float32Array;
  rgb: Uint8ClampedArray;
};

type RenderTransform = {
  isoX: number;
  isoY: number;
  zHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  hrMin: number;
  hrMax: number;
  mapMin: number;
  mapMax: number;
  grid: TerrainGrid;
};

function sampleZ(grid: TerrainGrid, worldX: number, worldY: number): number {
  const gx = clamp(worldX, 0, 1) * (grid.width - 1);
  const gy = clamp(worldY, 0, 1) * (grid.height - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;

  const idx00 = y0 * grid.width + x0;
  const idx10 = y0 * grid.width + x1;
  const idx01 = y1 * grid.width + x0;
  const idx11 = y1 * grid.width + x1;
  const z00 = grid.z[idx00] ?? 0;
  const z10 = grid.z[idx10] ?? 0;
  const z01 = grid.z[idx01] ?? 0;
  const z11 = grid.z[idx11] ?? 0;

  const z0 = lerp(z00, z10, tx);
  const z1 = lerp(z01, z11, tx);
  return lerp(z0, z1, ty);
}

function projectPoint(transform: RenderTransform, worldX: number, worldY: number, z01: number) {
  const zWorld = z01 * transform.zHeight;
  const px = (worldX - worldY) * transform.isoX;
  const py = (worldX + worldY) * transform.isoY - zWorld;
  return {
    x: px * transform.scale + transform.offsetX,
    y: py * transform.scale + transform.offsetY,
  };
}

export interface TerrainMapProps {
  syndrome: Syndrome;
  state: PatientState;
  history?: PatientState[];
  previewState?: PatientState | null;
  onSelectPoint?: (next: { hr: number; map: number }, commit: boolean) => void;
  interactionDisabled?: boolean;
  hrMin?: number;
  hrMax?: number;
  mapMin?: number;
  mapMax?: number;
}

export function TerrainMap({
  syndrome,
  state,
  history = [],
  previewState = null,
  onSelectPoint,
  interactionDisabled = false,
  hrMin = 60,
  hrMax = 180,
  mapMin = 40,
  mapMax = 110,
}: TerrainMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<RenderTransform | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const { pulsePressure } = getDerivedState(state);
  const { rr, spo2, temp, lactate, mentalState, capRefill, reserve } = state;

  const grid = useMemo<TerrainGrid>(() => {
    // Low-res mesh keeps interactive redraw cheap on mobile.
    const width = 64;
    const height = 48;
    const z = new Float32Array(width * height);
    const rgb = new Uint8ClampedArray(width * height * 3);

    for (let gy = 0; gy < height; gy++) {
      const hr = hrMax - (gy / (height - 1)) * (hrMax - hrMin);
      for (let gx = 0; gx < width; gx++) {
        const map = mapMin + (gx / (width - 1)) * (mapMax - mapMin);
        const { sbp, dbp } = stateAtMap(pulsePressure, map);
        const sample: PatientState = {
          hr,
          sbp,
          dbp,
          rr,
          spo2,
          temp,
          lactate,
          mentalState,
          capRefill,
          reserve,
        };

        const idx = gy * width + gx;
        const z01 = getSeverityZ(sample, syndrome);
        z[idx] = z01;
        const { r, g, b } = colorForSeverity(z01);
        const base = idx * 3;
        rgb[base] = r;
        rgb[base + 1] = g;
        rgb[base + 2] = b;
      }
    }

    return { width, height, z, rgb };
  }, [
    capRefill,
    hrMax,
    hrMin,
    lactate,
    mapMax,
    mapMin,
    mentalState,
    pulsePressure,
    reserve,
    rr,
    spo2,
    syndrome,
    temp,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      if (!cssWidth || !cssHeight) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const isoX = 0.92;
      const isoY = 0.48;
      const zHeight = 0.62;
      const marginPx = 18;

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (let gy = 0; gy < grid.height; gy++) {
        const worldY = gy / (grid.height - 1);
        for (let gx = 0; gx < grid.width; gx++) {
          const worldX = gx / (grid.width - 1);
          const z01 = grid.z[gy * grid.width + gx] ?? 0;
          const zWorld = z01 * zHeight;
          const px = (worldX - worldY) * isoX;
          const py = (worldX + worldY) * isoY - zWorld;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        }
      }

      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);
      const scale = Math.min(
        (cssWidth - 2 * marginPx) / spanX,
        (cssHeight - 2 * marginPx) / spanY
      );
      const offsetX = (cssWidth - spanX * scale) / 2 - minX * scale;
      const offsetY = (cssHeight - spanY * scale) / 2 - minY * scale;

      const transform: RenderTransform = {
        isoX,
        isoY,
        zHeight,
        scale,
        offsetX,
        offsetY,
        hrMin,
        hrMax,
        mapMin,
        mapMax,
        grid,
      };
      transformRef.current = transform;

      const light = normalize3(-0.6, -0.8, 1.0);
      const tertiary = getComputedStyle(document.documentElement)
        .getPropertyValue('--md-tertiary')
        .trim() || '#ee6c4d';
      const stepX = 1 / (grid.width - 1);
      const stepY = 1 / (grid.height - 1);

      ctx.lineWidth = 0.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (let sum = 0; sum <= grid.width + grid.height - 2; sum++) {
        for (let gy = 0; gy < grid.height - 1; gy++) {
          const gx = sum - gy;
          if (gx < 0 || gx >= grid.width - 1) continue;

          const idx00 = gy * grid.width + gx;
          const idx10 = gy * grid.width + (gx + 1);
          const idx01 = (gy + 1) * grid.width + gx;
          const idx11 = (gy + 1) * grid.width + (gx + 1);

          const z00 = grid.z[idx00] ?? 0;
          const z10 = grid.z[idx10] ?? 0;
          const z01 = grid.z[idx01] ?? 0;
          const z11 = grid.z[idx11] ?? 0;

          const worldX0 = gx / (grid.width - 1);
          const worldX1 = (gx + 1) / (grid.width - 1);
          const worldY0 = gy / (grid.height - 1);
          const worldY1 = (gy + 1) / (grid.height - 1);

          const p00 = projectPoint(transform, worldX0, worldY0, z00);
          const p10 = projectPoint(transform, worldX1, worldY0, z10);
          const p11 = projectPoint(transform, worldX1, worldY1, z11);
          const p01 = projectPoint(transform, worldX0, worldY1, z01);

          const dzdx = ((z10 - z00) * zHeight) / stepX;
          const dzdy = ((z01 - z00) * zHeight) / stepY;
          const normal = normalize3(-dzdx, -dzdy, 1);
          const intensity = clamp(dot3(normal, light) * 0.6 + 0.45, 0, 1);
          const shade = 0.62 + 0.45 * intensity;

          const r =
            ((grid.rgb[idx00 * 3] ?? 0) +
              (grid.rgb[idx10 * 3] ?? 0) +
              (grid.rgb[idx01 * 3] ?? 0) +
              (grid.rgb[idx11 * 3] ?? 0)) /
            4;
          const g =
            ((grid.rgb[idx00 * 3 + 1] ?? 0) +
              (grid.rgb[idx10 * 3 + 1] ?? 0) +
              (grid.rgb[idx01 * 3 + 1] ?? 0) +
              (grid.rgb[idx11 * 3 + 1] ?? 0)) /
            4;
          const b =
            ((grid.rgb[idx00 * 3 + 2] ?? 0) +
              (grid.rgb[idx10 * 3 + 2] ?? 0) +
              (grid.rgb[idx01 * 3 + 2] ?? 0) +
              (grid.rgb[idx11 * 3 + 2] ?? 0)) /
            4;

          ctx.beginPath();
          ctx.moveTo(p00.x, p00.y);
          ctx.lineTo(p10.x, p10.y);
          ctx.lineTo(p11.x, p11.y);
          ctx.lineTo(p01.x, p01.y);
          ctx.closePath();
          ctx.fillStyle = `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.06)';
          ctx.stroke();
        }
      }

      const projectState = (s: PatientState) => {
        const { map } = getDerivedState(s);
        const worldX = clamp((map - mapMin) / (mapMax - mapMin), 0, 1);
        const worldY = clamp((hrMax - s.hr) / (hrMax - hrMin), 0, 1);
        const z01 = getSeverityZ(s, syndrome);
        return projectPoint(transform, worldX, worldY, z01);
      };

      if (history.length > 1) {
        ctx.beginPath();
        history.forEach((s, idx) => {
          const p = projectState(s);
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      const current = projectState(state);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(current.x, current.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(current.x, current.y, 11, 0, Math.PI * 2);
      ctx.stroke();

      if (previewState) {
        const preview = projectState(previewState);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(current.x, current.y);
        ctx.lineTo(preview.x, preview.y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(preview.x, preview.y, 10, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = tertiary;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(preview.x, preview.y, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    render();

    if (typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(() => render());
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [grid, history, hrMax, hrMin, mapMax, mapMin, previewState, state, syndrome]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const emitSelection = (clientX: number, clientY: number, commit: boolean) => {
    if (!onSelectPoint) return;
    const transform = transformRef.current;
    const canvas = canvasRef.current;
    if (!transform || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;

    const px = (sx - transform.offsetX) / transform.scale;
    const py = (sy - transform.offsetY) / transform.scale;
    const u = px / transform.isoX;

    let worldX = (u + py / transform.isoY) / 2;
    let worldY = (py / transform.isoY - u) / 2;

    for (let i = 0; i < 3; i++) {
      worldX = clamp(worldX, 0, 1);
      worldY = clamp(worldY, 0, 1);
      const z01 = sampleZ(transform.grid, worldX, worldY);
      const v = (py + z01 * transform.zHeight) / transform.isoY;
      worldX = (u + v) / 2;
      worldY = (v - u) / 2;
    }

    worldX = clamp(worldX, 0, 1);
    worldY = clamp(worldY, 0, 1);

    const map = transform.mapMin + worldX * (transform.mapMax - transform.mapMin);
    const hr = transform.hrMax - worldY * (transform.hrMax - transform.hrMin);
    onSelectPoint({ hr, map }, commit);
  };

  const scheduleSelection = (clientX: number, clientY: number, commit: boolean) => {
    if (!onSelectPoint) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      emitSelection(clientX, clientY, commit);
    });
  };

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full touch-none"
      aria-label="3D HR/MAP viability terrain (toy model)"
      onPointerDown={(e) => {
        if (interactionDisabled || !onSelectPoint) return;
        draggingRef.current = true;
        (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
        scheduleSelection(e.clientX, e.clientY, false);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current || interactionDisabled || !onSelectPoint) return;
        scheduleSelection(e.clientX, e.clientY, false);
      }}
      onPointerUp={(e) => {
        if (!draggingRef.current || interactionDisabled || !onSelectPoint) return;
        draggingRef.current = false;
        scheduleSelection(e.clientX, e.clientY, true);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    />
  );
}
