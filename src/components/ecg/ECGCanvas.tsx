'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';

export interface ECGSegment {
  signal: number[];
  fs: number; // sampling frequency in Hz
  duration: number; // seconds
  units?: string;
  label?: string;
  source?: string;
}

interface ECGCanvasProps {
  segment: ECGSegment;
  width?: number;
  height?: number;
  secondsVisible?: number; // how many seconds to show at once
  gridColor?: string;
  traceColor?: string;
  backgroundColor?: string;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
}

export function ECGCanvas({
  segment,
  width = 800,
  height = 300,
  secondsVisible = 4, // Show 4 seconds at a time
  gridColor = 'rgba(200, 100, 100, 0.4)',
  traceColor = '#00ff00',
  backgroundColor = '#111111',
  playing: externalPlaying,
  onPlayingChange,
}: ECGCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [internalPlaying, setInternalPlaying] = useState(false);
  const animationRef = useRef<number | null>(null);
  const startSampleRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);

  const playing = externalPlaying ?? internalPlaying;
  const setPlaying = onPlayingChange ?? setInternalPlaying;

  // Handle high-DPI displays
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const canvasWidth = width * dpr;
  const canvasHeight = height * dpr;

  // Calculate Y-axis range from the data with padding
  const { yMin, yMax } = useMemo(() => {
    const vals = segment.signal.filter(v => v !== null && !isNaN(v));
    if (vals.length === 0) return { yMin: -1, yMax: 1 };

    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    const range = dataMax - dataMin || 1;
    const padding = range * 0.15;

    return {
      yMin: dataMin - padding,
      yMax: dataMax + padding,
    };
  }, [segment.signal]);

  const yRange = yMax - yMin;

  // Samples visible at once
  const samplesVisible = Math.floor(secondsVisible * segment.fs);

  // Pixels per sample - at 250Hz and 4 seconds visible on 800px, that's 1000 samples / 800px = 0.8px per sample
  const pxPerSample = width / samplesVisible;

  const drawGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    const pxPerSecond = width / secondsVisible;
    const smallSquarePx = pxPerSecond * 0.04; // 1mm = 0.04s at 25mm/s
    const largeSquarePx = smallSquarePx * 5;

    // Small grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;

    for (let x = 0; x < width; x += smallSquarePx) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, 0);
      ctx.lineTo(Math.floor(x) + 0.5, height);
      ctx.stroke();
    }

    for (let y = 0; y < height; y += smallSquarePx) {
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(y) + 0.5);
      ctx.lineTo(width, Math.floor(y) + 0.5);
      ctx.stroke();
    }

    // Large grid
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += largeSquarePx) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, 0);
      ctx.lineTo(Math.floor(x) + 0.5, height);
      ctx.stroke();
    }

    for (let y = 0; y < height; y += largeSquarePx) {
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(y) + 0.5);
      ctx.lineTo(width, Math.floor(y) + 0.5);
      ctx.stroke();
    }
  }, [width, height, gridColor, secondsVisible]);

  const drawTrace = useCallback((ctx: CanvasRenderingContext2D, startSample: number) => {
    ctx.strokeStyle = traceColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    let firstPoint = true;
    const signalLen = segment.signal.length;

    for (let i = 0; i < samplesVisible && i < signalLen; i++) {
      const sampleIdx = Math.floor(startSample + i) % signalLen;
      const val = segment.signal[sampleIdx];

      if (val === null || isNaN(val)) continue;

      const x = i * pxPerSample;

      // Map value to Y coordinate (canvas Y is inverted)
      const normalizedY = (val - yMin) / yRange;
      const y = height * (1 - normalizedY);

      if (firstPoint) {
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }, [segment.signal, samplesVisible, pxPerSample, height, yMin, yRange, traceColor]);

  const draw = useCallback((startSample: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set up for high-DPI
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // Grid
    drawGrid(ctx);

    // Trace
    drawTrace(ctx, startSample);

    // Labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '11px monospace';

    const currentTime = startSample / segment.fs;
    ctx.fillText(`${segment.label || 'ECG'} | 25mm/s`, 8, 16);
    ctx.fillText(`${currentTime.toFixed(1)}s`, 8, height - 8);
  }, [width, height, backgroundColor, drawGrid, drawTrace, segment, canvasWidth, canvasHeight, dpr]);

  // Animation loop
  useEffect(() => {
    if (!playing) {
      lastTimeRef.current = null;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      return;
    }

    const animate = (timestamp: number) => {
      if (lastTimeRef.current === null) {
        lastTimeRef.current = timestamp;
      }

      const delta = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;

      // Real-time playback speed
      startSampleRef.current += (delta / 1000) * segment.fs;

      if (startSampleRef.current >= segment.signal.length) {
        startSampleRef.current = 0;
      }

      draw(startSampleRef.current);
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [playing, segment.fs, segment.signal.length, draw]);

  // Initial draw and redraw on segment change
  useEffect(() => {
    startSampleRef.current = 0;
    draw(0);
  }, [draw, segment]);

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        className="rounded cursor-pointer"
        style={{ width, height }}
        onClick={() => setPlaying(!playing)}
      />
      <div className="flex gap-2 items-center">
        <button
          onClick={() => setPlaying(!playing)}
          className={`px-3 py-1.5 rounded text-sm font-medium ${
            playing
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-green-600 hover:bg-green-700 text-white'
          }`}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={() => {
            startSampleRef.current = 0;
            draw(0);
          }}
          className="px-3 py-1.5 rounded text-sm font-medium bg-gray-600 hover:bg-gray-700 text-white"
        >
          Reset
        </button>
        <span className="text-xs text-gray-500 ml-2">
          {segment.source}
        </span>
      </div>
    </div>
  );
}
