import type { ActionOperator, PatientState, Syndrome } from '@/lib/medical-cockpit';
import { getDerivedState, getViabilityComponents } from '@/lib/medical-cockpit';
import { clamp } from '@/lib/utils/clamp';
import { Metric } from './Metric';
import { ReserveCurve } from './ReserveCurve';
import { Slider } from './Slider';

export type CockpitPanelId = 'actions' | 'controls' | 'sim';

const ACTION_LABELS: Record<ActionOperator, string> = {
  fluids: 'Fluids',
  blood: 'Blood',
  intubate: 'Intubate',
  wait: 'Wait',
};

export function formatPercent(value01: number): string {
  return `${Math.round(clamp(value01, 0, 1) * 100)}%`;
}

function formatDelta(value: number, digits = 2): string {
  const rounded = Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(digits)}`;
}

function stateAtMap(pulsePressure: number, map: number): { sbp: number; dbp: number } {
  const pp = clamp(Number.isFinite(pulsePressure) ? pulsePressure : 40, 20, 80);
  const dbp = map - pp / 3;
  const sbp = dbp + pp;
  return { sbp, dbp };
}

export interface CockpitPanelProps {
  activePanel: CockpitPanelId;
  setActivePanel: (panel: CockpitPanelId) => void;
  pendingAction: ActionOperator | null;
  selectAction: (action: ActionOperator) => void;
  applySelectedAction: () => void;
  setPendingAction: (action: ActionOperator | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  handleUndo: () => void;
  handleRedo: () => void;
  handleReset: () => void;
  previewDerived: ReturnType<typeof getDerivedState> | null;
  previewMargin: number | null;
  previewSeverity: number | null;
  margin: number;
  severity: number;
  components: ReturnType<typeof getViabilityComponents>;
  syndrome: Syndrome;
  state: PatientState;
  previewState: PatientState | null;
  bleedRate: number;
  setBleedRate: (v: number) => void;
  handleBleedStep: () => void;
  isBleeding: boolean;
  setIsBleeding: (v: boolean) => void;
  pushState: (next: PatientState) => void;
  setTerrainDraft: (next: { hr: number; map: number } | null) => void;
}

export function CockpitPanel({
  activePanel,
  setActivePanel,
  pendingAction,
  selectAction,
  applySelectedAction,
  setPendingAction,
  canUndo,
  canRedo,
  handleUndo,
  handleRedo,
  handleReset,
  previewDerived,
  previewMargin,
  previewSeverity,
  margin,
  severity,
  components,
  syndrome,
  state,
  previewState,
  bleedRate,
  setBleedRate,
  handleBleedStep,
  isBleeding,
  setIsBleeding,
  pushState,
  setTerrainDraft,
}: CockpitPanelProps) {
  const tabButton = (id: CockpitPanelId, label: string) => (
    <button
      key={id}
      onClick={() => setActivePanel(id)}
      className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
        activePanel === id
          ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)] border-transparent'
          : 'bg-[var(--md-surface-container)] text-[var(--md-on-surface)] border-[var(--md-outline-variant)] hover:bg-[var(--md-surface-container-high)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {tabButton('actions', 'Actions')}
        {tabButton('controls', 'Controls')}
        {tabButton('sim', 'Sim')}
      </div>

      <div className="flex-1 min-h-0 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-3 overflow-hidden">
        {activePanel === 'actions' && (
          <div className="h-full flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {(['fluids', 'blood', 'intubate', 'wait'] as ActionOperator[]).map((action) => (
                <button
                  key={action}
                  onClick={() => selectAction(action)}
                  className={`px-3 py-2 rounded-lg border text-sm text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] ${
                    pendingAction === action
                      ? 'border-[var(--md-tertiary)] bg-[var(--md-tertiary-container)]'
                      : 'border-[var(--md-outline)]'
                  }`}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </div>

            {pendingAction && previewDerived && previewMargin !== null && previewSeverity !== null && (
              <div className="rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-3 space-y-2">
                <div className="text-xs text-[var(--md-on-surface-variant)]">
                  Preview <span className="font-semibold text-[var(--md-on-surface)]">{ACTION_LABELS[pendingAction]}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="Δ Margin" value={formatDelta(previewMargin - margin)} />
                  <Metric label="Δ Z" value={formatDelta(previewSeverity - severity)} />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={applySelectedAction}
                    className="px-3 py-1.5 rounded-lg bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)] text-xs hover:brightness-105"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => setPendingAction(null)}
                    className="px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Metric label="Perfusion" value={formatPercent(components.perfusion)} />
              <Metric label="O₂" value={formatPercent(components.oxygenation)} />
              <Metric label="Metabolic" value={formatPercent(components.metabolic)} />
              <Metric label="Reserve" value={formatPercent(components.reserve)} />
            </div>
          </div>
        )}

        {activePanel === 'controls' && (
          <div className="h-full flex flex-col gap-3">
            <ReserveCurve syndrome={syndrome} state={state} previewState={previewState} />

            <div className="space-y-3">
              <Slider
                label="Reserve"
                value={state.reserve}
                min={0}
                max={1}
                step={0.01}
                unit=""
                onChange={(v) => {
                  setTerrainDraft(null);
                  pushState({ ...state, reserve: v });
                }}
                format={(v) => v.toFixed(2)}
              />

              <Slider
                label="Pulse pressure"
                value={getDerivedState(state).pulsePressure}
                min={20}
                max={80}
                step={1}
                unit="mmHg"
                onChange={(pp) => {
                  setTerrainDraft(null);
                  const { map } = getDerivedState(state);
                  const { sbp, dbp } = stateAtMap(pp, map);
                  pushState({ ...state, sbp, dbp });
                }}
              />
            </div>
          </div>
        )}

        {activePanel === 'sim' && (
          <div className="h-full flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <button
                onClick={handleBleedStep}
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm hover:opacity-90"
              >
                Step bleed
              </button>
              <button
                onClick={() => {
                  setTerrainDraft(null);
                  setIsBleeding(!isBleeding);
                }}
                className="px-3 py-2 rounded-lg bg-[var(--md-surface-container-high)] border border-[var(--md-outline-variant)] text-sm text-[var(--md-on-surface)] hover:brightness-105"
              >
                {isBleeding ? 'Pause' : 'Play'}
              </button>
            </div>

            <Slider
              label="Bleed rate"
              value={bleedRate}
              min={0}
              max={120}
              step={1}
              unit="ml/min"
              onChange={(v) => {
                setTerrainDraft(null);
                setBleedRate(v);
              }}
            />

            <div className="text-xs text-[var(--md-on-surface-variant)]">
              Drag terrain to adjust HR/MAP. Bleed sim updates every ~0.9s.
            </div>

            <div className="grid grid-cols-3 gap-2 sm:hidden">
              <button
                onClick={handleUndo}
                disabled={!canUndo}
                className="px-3 py-2 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Undo
              </button>
              <button
                onClick={handleRedo}
                disabled={!canRedo}
                className="px-3 py-2 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Redo
              </button>
              <button
                onClick={handleReset}
                className="px-3 py-2 rounded-lg border border-[var(--md-outline)] text-xs text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
