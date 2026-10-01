'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionOperator, PatientState, Syndrome } from '@/lib/medical-cockpit';
import {
  applyActionOperator,
  createInitialState,
  getDerivedState,
  getSeverityZ,
  getViabilityComponents,
  getViabilityMargin,
  stepHemorrhageDynamics,
} from '@/lib/medical-cockpit';
import { clamp } from '@/lib/utils/clamp';
import { CockpitPanel, formatPercent } from './CockpitPanel';
import type { CockpitPanelId } from './CockpitPanel';
import { Metric } from './Metric';
import { TerrainMap } from './TerrainMap';

function stateAtMap(pulsePressure: number, map: number): { sbp: number; dbp: number } {
  const pp = clamp(Number.isFinite(pulsePressure) ? pulsePressure : 40, 20, 80);
  const dbp = map - pp / 3;
  const sbp = dbp + pp;
  return { sbp, dbp };
}

const TERRAIN_BOUNDS = {
  hrMin: 60,
  hrMax: 180,
  mapMin: 40,
  mapMax: 110,
} as const;

const SYNDROME_LABELS: Record<Syndrome, string> = {
  paeds_hemorrhage: 'Paeds haemorrhage (toy)',
  hypovolemic_shock: 'Hypovolemic shock (toy)',
  healthy: 'Healthy baseline (toy)',
};

type TimelineState = {
  states: PatientState[];
  cursor: number;
};

export function CockpitLab() {
  const [syndrome, setSyndrome] = useState<Syndrome>('paeds_hemorrhage');
  const [timeline, setTimeline] = useState<TimelineState>(() => {
    const initial = createInitialState('paeds_hemorrhage');
    return { states: [initial], cursor: 0 };
  });
  const [pendingAction, setPendingAction] = useState<ActionOperator | null>(null);
  const [activePanel, setActivePanel] = useState<CockpitPanelId>('actions');
  const [showInfo, setShowInfo] = useState(false);
  const [terrainDraft, setTerrainDraft] = useState<{ hr: number; map: number } | null>(null);
  const [bleedRate, setBleedRate] = useState(40);
  const [isBleeding, setIsBleeding] = useState(false);

  const state = timeline.states[timeline.cursor];
  const history = useMemo(() => timeline.states.slice(0, timeline.cursor + 1), [timeline]);
  const activeState = useMemo(() => {
    if (!terrainDraft) return state;
    const { pulsePressure } = getDerivedState(state);
    const { sbp, dbp } = stateAtMap(pulsePressure, terrainDraft.map);
    return { ...state, hr: terrainDraft.hr, sbp, dbp };
  }, [state, terrainDraft]);
  const displayHistory = useMemo(() => {
    if (!terrainDraft) return history;
    if (history.length === 0) return [activeState];
    return [...history.slice(0, -1), activeState];
  }, [activeState, history, terrainDraft]);

  const derived = useMemo(() => getDerivedState(activeState), [activeState]);
  const margin = useMemo(() => getViabilityMargin(activeState, syndrome), [activeState, syndrome]);
  const severity = useMemo(() => getSeverityZ(activeState, syndrome), [activeState, syndrome]);
  const components = useMemo(
    () => getViabilityComponents(activeState, syndrome),
    [activeState, syndrome]
  );

  const previewState = useMemo(
    () => (pendingAction ? applyActionOperator(activeState, pendingAction) : null),
    [activeState, pendingAction]
  );
  const previewDerived = useMemo(
    () => (previewState ? getDerivedState(previewState) : null),
    [previewState]
  );
  const previewMargin = useMemo(
    () => (previewState ? getViabilityMargin(previewState, syndrome) : null),
    [previewState, syndrome]
  );
  const previewSeverity = useMemo(
    () => (previewState ? getSeverityZ(previewState, syndrome) : null),
    [previewState, syndrome]
  );

  const pushState = (next: PatientState) => {
    setTimeline((prev) => {
      const head = prev.states.slice(0, prev.cursor + 1);
      const nextStates = [...head, next];
      const capped = nextStates.length > 160 ? nextStates.slice(-160) : nextStates;
      return { states: capped, cursor: capped.length - 1 };
    });
  };

  const handleReset = () => {
    const initial = createInitialState(syndrome);
    setTimeline({ states: [initial], cursor: 0 });
    setPendingAction(null);
    setTerrainDraft(null);
    setIsBleeding(false);
  };

  const handleUndo = () => {
    setTerrainDraft(null);
    setTimeline((prev) => ({ ...prev, cursor: Math.max(0, prev.cursor - 1) }));
    setPendingAction(null);
  };

  const handleRedo = () => {
    setTerrainDraft(null);
    setTimeline((prev) => ({ ...prev, cursor: Math.min(prev.states.length - 1, prev.cursor + 1) }));
    setPendingAction(null);
  };

  const handleBleedStep = () => {
    const next = stepHemorrhageDynamics(activeState, syndrome, bleedRate, 1);
    setTerrainDraft(null);
    pushState(next);
  };

  const handleSyndromeChange = (nextSyndrome: Syndrome) => {
    setSyndrome(nextSyndrome);
    const initial = createInitialState(nextSyndrome);
    setTimeline({ states: [initial], cursor: 0 });
    setPendingAction(null);
    setTerrainDraft(null);
    setIsBleeding(false);
  };

  const canUndo = timeline.cursor > 0;
  const canRedo = timeline.cursor < timeline.states.length - 1;

  useEffect(() => {
    if (!isBleeding) return;
    const handle = window.setInterval(() => {
      setTimeline((prev) => {
        const current = prev.states[prev.cursor];
        const next = stepHemorrhageDynamics(current, syndrome, bleedRate, 1);
        const head = prev.states.slice(0, prev.cursor + 1);
        const nextStates = [...head, next];
        const capped = nextStates.length > 160 ? nextStates.slice(-160) : nextStates;
        return { states: capped, cursor: capped.length - 1 };
      });
    }, 900);
    return () => window.clearInterval(handle);
  }, [bleedRate, isBleeding, syndrome]);

  const selectAction = (action: ActionOperator) => {
    setPendingAction((prev) => (prev === action ? null : action));
  };

  const applySelectedAction = () => {
    if (!pendingAction) return;
    setTerrainDraft(null);
    pushState(applyActionOperator(activeState, pendingAction));
    setPendingAction(null);
  };

  const handleTerrainSelection = (next: { hr: number; map: number }, commit: boolean) => {
    setPendingAction(null);

    const nextHr = clamp(next.hr, 40, 220);
    const nextMap = clamp(next.map, TERRAIN_BOUNDS.mapMin, TERRAIN_BOUNDS.mapMax);

    if (!commit) {
      setTerrainDraft({ hr: nextHr, map: nextMap });
      return;
    }

    const { pulsePressure } = getDerivedState(state);
    const { sbp, dbp } = stateAtMap(pulsePressure, nextMap);
    setTerrainDraft(null);
    pushState({ ...state, hr: nextHr, sbp, dbp });
  };

  return (
    <div className="h-[100svh] overflow-hidden bg-[var(--md-surface)] flex flex-col">
      <div className="flex-none flex items-center justify-between gap-3 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface)]">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href="/"
            className="text-xs text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]"
          >
            MD3
          </Link>
          <div className="text-sm font-semibold text-[var(--md-on-surface)] truncate">
            Cockpit
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]">
            Experimental
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-[var(--md-on-surface-variant)]">
            <span className="sr-only">Syndrome</span>
            <select
              className="px-2.5 py-1.5 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
              value={syndrome}
              onChange={(e) => handleSyndromeChange(e.target.value as Syndrome)}
            >
              {Object.entries(SYNDROME_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={handleUndo}
            disabled={!canUndo}
            className="hidden sm:inline-flex px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Undo
          </button>

          <button
            onClick={handleRedo}
            disabled={!canRedo}
            className="hidden sm:inline-flex px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Redo
          </button>

          <button
            onClick={handleReset}
            className="hidden sm:inline-flex px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]"
          >
            Reset
          </button>

          <button
            onClick={() => setShowInfo(true)}
            className="px-3 py-1.5 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
          >
            Info
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr,360px]">
        <div className="min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 p-3">
            <div className="relative w-full h-full rounded-xl overflow-hidden border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]">
              <TerrainMap
                syndrome={syndrome}
                state={activeState}
                history={displayHistory}
                previewState={previewState}
                onSelectPoint={handleTerrainSelection}
                interactionDisabled={isBleeding}
                hrMin={TERRAIN_BOUNDS.hrMin}
                hrMax={TERRAIN_BOUNDS.hrMax}
                mapMin={TERRAIN_BOUNDS.mapMin}
                mapMax={TERRAIN_BOUNDS.mapMax}
              />

              <div className="pointer-events-none absolute top-3 left-3 grid grid-cols-2 gap-2">
                <Metric label="MAP" value={`${derived.map.toFixed(0)} mmHg`} />
                <Metric label="Shock" value={Number.isFinite(derived.shockIndex) ? derived.shockIndex.toFixed(2) : '∞'} />
                <Metric label="Margin" value={formatPercent(margin)} />
                <Metric label="Z" value={formatPercent(severity)} />
              </div>

              <div className="pointer-events-none absolute top-3 right-3">
                <div className="px-2 py-1 rounded-lg text-[10px] tracking-wide text-[var(--md-on-surface-variant)] bg-[var(--md-surface)]/70 border border-[var(--md-outline-variant)]">
                  Step {timeline.cursor + 1}/{timeline.states.length}
                </div>
              </div>
            </div>
          </div>

          <div className="lg:hidden flex-none px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
            <div className="h-[34svh] max-h-[320px] min-h-[240px]">
              <CockpitPanel
                activePanel={activePanel}
                setActivePanel={setActivePanel}
                pendingAction={pendingAction}
                selectAction={selectAction}
                applySelectedAction={applySelectedAction}
                setPendingAction={setPendingAction}
                canUndo={canUndo}
                canRedo={canRedo}
                handleUndo={handleUndo}
                handleRedo={handleRedo}
                handleReset={handleReset}
                previewDerived={previewDerived}
                previewMargin={previewMargin}
                previewSeverity={previewSeverity}
                margin={margin}
                severity={severity}
                components={components}
                syndrome={syndrome}
                state={activeState}
                previewState={previewState}
                bleedRate={bleedRate}
                setBleedRate={setBleedRate}
                handleBleedStep={handleBleedStep}
                isBleeding={isBleeding}
                setIsBleeding={setIsBleeding}
                pushState={pushState}
                setTerrainDraft={setTerrainDraft}
              />
            </div>
          </div>
        </div>

        <div className="hidden lg:flex min-h-0 flex-col border-l border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-3">
          <CockpitPanel
            activePanel={activePanel}
            setActivePanel={setActivePanel}
            pendingAction={pendingAction}
            selectAction={selectAction}
            applySelectedAction={applySelectedAction}
            setPendingAction={setPendingAction}
            canUndo={canUndo}
            canRedo={canRedo}
            handleUndo={handleUndo}
            handleRedo={handleRedo}
            handleReset={handleReset}
            previewDerived={previewDerived}
            previewMargin={previewMargin}
            previewSeverity={previewSeverity}
            margin={margin}
            severity={severity}
            components={components}
            syndrome={syndrome}
            state={activeState}
            previewState={previewState}
            bleedRate={bleedRate}
            setBleedRate={setBleedRate}
            handleBleedStep={handleBleedStep}
            isBleeding={isBleeding}
            setIsBleeding={setIsBleeding}
            pushState={pushState}
            setTerrainDraft={setTerrainDraft}
          />
        </div>
      </div>

      {showInfo && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[var(--md-on-surface)]">
                Medical Cockpit (toy)
              </div>
              <button
                onClick={() => setShowInfo(false)}
                className="px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]"
              >
                Close
              </button>
            </div>
            <div className="text-sm text-[var(--md-on-surface-variant)] space-y-2">
              <p>Educational toy model. No diagnoses and no recommendations.</p>
              <p>Drag the terrain to set HR/MAP. Use Actions to preview → apply.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
