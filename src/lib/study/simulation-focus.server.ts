import type { SimulationFocus } from './simulation-focus';
/** Public distribution has no private timetable allocations. */
export function resolveSimulationFocus(_email: string | null | undefined, _rotation: string, _now = new Date(), _goal?: unknown): SimulationFocus | null { return null; }
