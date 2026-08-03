export type Syndrome = 'paeds_hemorrhage' | 'hypovolemic_shock' | 'healthy';

export type ActionOperator = 'fluids' | 'blood' | 'intubate' | 'wait';

export interface PatientState {
  hr: number; // bpm
  sbp: number; // mmHg
  dbp: number; // mmHg
  rr: number; // /min
  spo2: number; // %
  temp: number; // °C
  lactate: number; // mmol/L
  mentalState: number; // 0..1
  capRefill: number; // seconds
  reserve: number; // 0..1 (hidden compensation reserve)
}

export interface DerivedState {
  map: number; // mmHg
  pulsePressure: number; // mmHg
  shockIndex: number; // HR / SBP
}

export interface ViabilityComponents {
  perfusion: number; // 0..1
  oxygenation: number; // 0..1
  metabolic: number; // 0..1
  reserve: number; // 0..1
}

interface SyndromeConfig {
  mapCliff: number;
  shockIndexCliff: number;
  shockIndexSteepness?: number;
  spo2Cliff: number;
  lactateCliff: number;
  mentalStateCliff: number;
  paedsReservePlateauEnd?: number;
  paedsCliffSteepness?: number;
}

const SYNDROME_CONFIG: Record<Syndrome, SyndromeConfig> = {
  healthy: {
    mapCliff: 60,
    shockIndexCliff: 1.0,
    shockIndexSteepness: 10,
    spo2Cliff: 88,
    lactateCliff: 4.0,
    mentalStateCliff: 0.3,
  },
  hypovolemic_shock: {
    mapCliff: 60,
    shockIndexCliff: 1.0,
    shockIndexSteepness: 10,
    spo2Cliff: 88,
    lactateCliff: 4.0,
    mentalStateCliff: 0.3,
  },
  paeds_hemorrhage: {
    mapCliff: 60,
    shockIndexCliff: 1.1,
    shockIndexSteepness: 10,
    spo2Cliff: 88,
    lactateCliff: 4.0,
    mentalStateCliff: 0.3,
    paedsReservePlateauEnd: 0.3,
    paedsCliffSteepness: 20.0,
  },
};

import { clamp } from '@/lib/utils/clamp';

export function getDerivedState(state: PatientState): DerivedState {
  const pulsePressure = state.sbp - state.dbp;
  const map = state.dbp + pulsePressure / 3;
  const shockIndex = state.sbp > 0 ? state.hr / state.sbp : Number.POSITIVE_INFINITY;
  return { map, pulsePressure, shockIndex };
}

function sigmoid(x: number, k = 1, x0 = 0): number {
  return 1 / (1 + Math.exp(-k * (x - x0)));
}

function cliffFunction(x: number, threshold: number, steepness = 10): number {
  return sigmoid(x - threshold, steepness);
}

function perfusionMargin(state: PatientState, cfg: SyndromeConfig): number {
  const { map } = getDerivedState(state);
  const mapMargin = cliffFunction(map, cfg.mapCliff);
  const { shockIndex } = getDerivedState(state);
  const siSteepness = cfg.shockIndexSteepness ?? 10;
  const shockIndexMargin = clamp(2 * sigmoid(cfg.shockIndexCliff - shockIndex, siSteepness), 0, 1);
  const mentalMargin = cliffFunction(state.mentalState, cfg.mentalStateCliff);
  const capRefillMargin = cliffFunction(4.0 - state.capRefill, 0);
  return clamp(
    0.4 * mapMargin + 0.2 * shockIndexMargin + 0.25 * mentalMargin + 0.15 * capRefillMargin,
    0,
    1
  );
}

function oxygenationMargin(state: PatientState, cfg: SyndromeConfig): number {
  const spo2Margin = cliffFunction(state.spo2, cfg.spo2Cliff);
  const rrMargin = cliffFunction(35 - state.rr, 0, 0.5);
  return clamp(0.7 * spo2Margin + 0.3 * rrMargin, 0, 1);
}

function metabolicMargin(state: PatientState, cfg: SyndromeConfig): number {
  return clamp(cliffFunction(cfg.lactateCliff - state.lactate, 0), 0, 1);
}

function reserveMargin(state: PatientState, syndrome: Syndrome, cfg: SyndromeConfig): number {
  if (syndrome === 'paeds_hemorrhage') {
    const plateauEnd = cfg.paedsReservePlateauEnd ?? 0.3;
    const steepness = cfg.paedsCliffSteepness ?? 20.0;
    if (state.reserve > plateauEnd) return 1;
    return clamp(Math.exp(-steepness * (plateauEnd - state.reserve)), 0, 1);
  }

  // Adults: smoother decline
  return clamp(sigmoid(state.reserve - 0.3, 5), 0, 1);
}

export function getViabilityComponents(state: PatientState, syndrome: Syndrome): ViabilityComponents {
  const cfg = SYNDROME_CONFIG[syndrome];
  return {
    perfusion: perfusionMargin(state, cfg),
    oxygenation: oxygenationMargin(state, cfg),
    metabolic: metabolicMargin(state, cfg),
    reserve: reserveMargin(state, syndrome, cfg),
  };
}

/**
 * Conservative viability margin M(x) ∈ [0,1].
 * We intentionally use a min-like operator so the “worst axis wins” (interpretable).
 */
export function getViabilityMargin(state: PatientState, syndrome: Syndrome): number {
  const c = getViabilityComponents(state, syndrome);
  return clamp(Math.min(c.perfusion, c.oxygenation, c.metabolic, c.reserve), 0, 1);
}

/**
 * Severity surface Z ∈ [0,1], where 0 is safe and 1 is “at the cliff”.
 */
export function getSeverityZ(state: PatientState, syndrome: Syndrome): number {
  return clamp(1 - getViabilityMargin(state, syndrome), 0, 1);
}

export function createInitialState(syndrome: Syndrome): PatientState {
  switch (syndrome) {
    case 'paeds_hemorrhage':
      return {
        hr: 120,
        sbp: 95,
        dbp: 60,
        rr: 24,
        spo2: 97,
        temp: 36.8,
        lactate: 2.5,
        mentalState: 0.9,
        capRefill: 2.5,
        reserve: 0.6,
      };
    case 'hypovolemic_shock':
      return {
        hr: 110,
        sbp: 90,
        dbp: 65,
        rr: 22,
        spo2: 95,
        temp: 36.5,
        lactate: 3.0,
        mentalState: 0.8,
        capRefill: 3.0,
        reserve: 0.5,
      };
    default:
      return {
        hr: 75,
        sbp: 120,
        dbp: 80,
        rr: 14,
        spo2: 98,
        temp: 37.0,
        lactate: 1.0,
        mentalState: 1.0,
        capRefill: 2.0,
        reserve: 1.0,
      };
  }
}

export function stepHemorrhageDynamics(
  state: PatientState,
  syndrome: Syndrome,
  bloodLossRateMlPerMin: number,
  dtMinutes = 1
): PatientState {
  // Reserve depletion (hidden axis)
  const reserveLoss = (bloodLossRateMlPerMin / 5000) * dtMinutes;
  const nextReserve = clamp(state.reserve - reserveLoss, 0, 1);

  const isPaeds = syndrome === 'paeds_hemorrhage';
  const compensated = isPaeds ? nextReserve > 0.3 : true;

  let hr = state.hr;
  let sbp = state.sbp;
  let dbp = state.dbp;

  if (isPaeds) {
    if (compensated) {
      hr = state.hr + 5 * (1 - nextReserve) * dtMinutes;
      sbp = state.sbp - 2 * (1 - nextReserve) * dtMinutes;
      dbp = state.dbp + 3 * (1 - nextReserve) * dtMinutes;
    } else {
      const factor = (0.3 - nextReserve) / 0.3;
      hr = state.hr + 20 * factor * dtMinutes;
      sbp = state.sbp - 30 * factor * dtMinutes;
      dbp = state.dbp - 15 * factor * dtMinutes;
    }
  } else {
    hr = state.hr + 10 * (1 - nextReserve) * dtMinutes;
    sbp = state.sbp - 10 * (1 - nextReserve) * dtMinutes;
    dbp = state.dbp - 5 * (1 - nextReserve) * dtMinutes;
  }

  const lactate = clamp(state.lactate + 0.5 * (1 - nextReserve) * dtMinutes, 0.5, 15);
  const capRefill = clamp(state.capRefill + 0.5 * (1 - nextReserve) * dtMinutes, 0.5, 8);
  const mentalState = clamp(state.mentalState - 0.1 * (1 - nextReserve) * dtMinutes, 0, 1);

  return {
    ...state,
    hr: clamp(hr, 40, 220),
    sbp: clamp(sbp, 40, 220),
    dbp: clamp(dbp, 20, 140),
    lactate,
    capRefill,
    mentalState,
    reserve: nextReserve,
  };
}

export function applyActionOperator(
  state: PatientState,
  action: ActionOperator
): PatientState {
  switch (action) {
    case 'fluids': {
      const volumeEffect = 0.5; // 500mL normalized to 0.5L
      return {
        ...state,
        hr: clamp(state.hr - 10 * volumeEffect * state.reserve, 40, 220),
        sbp: clamp(state.sbp + 15 * volumeEffect * state.reserve, 40, 220),
        dbp: clamp(state.dbp + 5 * volumeEffect * state.reserve, 20, 140),
        lactate: state.lactate > 2 ? clamp(state.lactate - 0.3 * volumeEffect, 0.5, 15) : state.lactate,
        mentalState: clamp(state.mentalState + 0.1 * volumeEffect * state.reserve, 0, 1),
        capRefill: clamp(state.capRefill - 0.5 * volumeEffect * state.reserve, 0.5, 8),
        reserve: clamp(state.reserve + 0.1 * volumeEffect, 0, 1),
      };
    }
    case 'blood': {
      const effect = 0.15; // 1 unit
      return {
        ...state,
        hr: clamp(state.hr - 15 * effect, 40, 220),
        sbp: clamp(state.sbp + 20 * effect, 40, 220),
        dbp: clamp(state.dbp + 10 * effect, 20, 140),
        rr: clamp(state.rr - 5 * effect, 8, 60),
        spo2: clamp(state.spo2 + 5 * effect, 0, 100),
        lactate: clamp(state.lactate - 0.5 * effect, 0.5, 15),
        mentalState: clamp(state.mentalState + 0.2 * effect, 0, 1),
        capRefill: clamp(state.capRefill - 1.0 * effect, 0.5, 8),
        reserve: clamp(state.reserve + 0.2 * effect, 0, 1),
      };
    }
    case 'intubate':
      return {
        ...state,
        hr: clamp(state.hr + 20, 40, 220),
        sbp: clamp(state.sbp - 30, 40, 220),
        dbp: clamp(state.dbp - 15, 20, 140),
        rr: 14,
        spo2: clamp(state.spo2 + 10, 0, 100),
        mentalState: 0,
        reserve: clamp(state.reserve - 0.1, 0, 1),
      };
    case 'wait': {
      const drift = 0.02;
      return {
        ...state,
        hr: clamp(state.hr + 2, 40, 220),
        sbp: clamp(state.sbp - 1, 40, 220),
        lactate: clamp(state.lactate + 0.1, 0.5, 15),
        capRefill: clamp(state.capRefill + 0.1, 0.5, 8),
        reserve: clamp(state.reserve - drift, 0, 1),
      };
    }
  }
}
