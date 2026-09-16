export type TimeSeriesPoint = {
  timeHours: number;
  value: number;
};

export type EventPoint = {
  id: string;
  timeHours: number;
};

export type WindowSpec = {
  baselineHours: [number, number];
  followupHours: [number, number];
  minBaselinePoints?: number;
  minFollowupPoints?: number;
};

export type WindowDelta = {
  eventId: string;
  eventTimeHours: number;
  baselineMedian: number;
  followupMedian: number;
  delta: number;
  baselineCount: number;
  followupCount: number;
};

export type DeltaSummary = {
  totalEvents: number;
  usedEvents: number;
  deltas: WindowDelta[];
  medianDelta: number | null;
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

function collectWindow(series: TimeSeriesPoint[], eventTime: number, window: [number, number]): number[] {
  const [start, end] = window;
  const startTime = eventTime + start;
  const endTime = eventTime + end;

  return series
    .filter((point) => point.timeHours >= startTime && point.timeHours <= endTime)
    .map((point) => point.value);
}

export function computeWindowDelta(
  series: TimeSeriesPoint[],
  event: EventPoint,
  windowSpec: WindowSpec,
): WindowDelta | null {
  const baselineValues = collectWindow(series, event.timeHours, windowSpec.baselineHours);
  const followupValues = collectWindow(series, event.timeHours, windowSpec.followupHours);

  const minBaselinePoints = windowSpec.minBaselinePoints ?? 1;
  const minFollowupPoints = windowSpec.minFollowupPoints ?? 1;

  if (baselineValues.length < minBaselinePoints || followupValues.length < minFollowupPoints) {
    return null;
  }

  const baselineMedian = median(baselineValues);
  const followupMedian = median(followupValues);

  if (baselineMedian === null || followupMedian === null) return null;

  return {
    eventId: event.id,
    eventTimeHours: event.timeHours,
    baselineMedian,
    followupMedian,
    delta: followupMedian - baselineMedian,
    baselineCount: baselineValues.length,
    followupCount: followupValues.length,
  };
}

export function summarizeEventDeltas(
  series: TimeSeriesPoint[],
  events: EventPoint[],
  windowSpec: WindowSpec,
): DeltaSummary {
  const deltas: WindowDelta[] = [];

  events.forEach((event) => {
    const delta = computeWindowDelta(series, event, windowSpec);
    if (delta) {
      deltas.push(delta);
    }
  });

  const deltaValues = deltas.map((entry) => entry.delta);

  return {
    totalEvents: events.length,
    usedEvents: deltas.length,
    deltas,
    medianDelta: median(deltaValues),
  };
}
