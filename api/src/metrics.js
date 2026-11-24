import { DateTime } from "luxon";

export function dayWindow(date, zone) {
  const d = DateTime.fromISO(date, { zone });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !d.isValid || d.toISODate() !== date)
    throw new Error("Invalid date or time zone");
  return {
    start: d.startOf("day").toMillis(),
    end: d.startOf("day").plus({ days: 1 }).toMillis(),
  };
}

export function unionSeconds(intervals, start = -Infinity, end = Infinity) {
  let total = 0,
    edge = -Infinity;
  for (const [a, b] of intervals
    .map(([a, b]) => [Math.max(+a, start), Math.min(+b, end)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])) {
    total += Math.max(0, b - Math.max(a, edge));
    edge = Math.max(edge, b);
  }
  return total / 1000;
}

function sortedUnionSeconds(sortedPairs, start = -Infinity, end = Infinity) {
  let total = 0,
    edge = -Infinity;
  for (let i = 0; i < sortedPairs.length; i++) {
    const a = sortedPairs[i][0];
    if (a >= end) break;
    const b = sortedPairs[i][1];
    if (b <= start) continue;
    const cs = a < start ? start : a;
    const ce = b > end ? end : b;
    if (ce > cs) {
      total += Math.max(0, ce - Math.max(cs, edge));
      edge = Math.max(edge, ce);
    }
  }
  return total / 1000;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function activityReport(events, start, end, zone, extra = {}) {
  const intervals = events.filter((e) => e.type === "interval");
  const active = intervals.filter((e) => e.state === "active");
  const idle = intervals.filter((e) => e.state === "idle");
  const byStart = (x, y) => x[0] - y[0];
  const pairs = (es) => es.map((e) => [+new Date(e.start), +new Date(e.end)]);
  const allPairs = pairs(intervals).sort(byStart);
  const activePairsRaw = pairs(active);
  const activePairs = [...activePairsRaw].sort(byStart);
  const idlePairs = pairs(idle).sort(byStart);
  const switchTimes = events
    .filter((e) => e.type === "tab_switch")
    .map((e) => +new Date(e.at));
  const focusPairs = (extra.segments || [])
    .map((s) => [+new Date(s.started_at ?? s[0]), +new Date(s.ended_at ?? s[1])])
    .sort(byStart);
  const checkins = extra.checkins || [];

  const hours = [];
  for (let t = start; t < end; t += 3600000) {
    const until = Math.min(t + 3600000, end);
    const hourCheckins = checkins.filter((c) => {
      const at = +new Date(c.recorded_at);
      return at >= t && at < until;
    });
    const avg = (key) => {
      const vals = hourCheckins
        .map((c) => c[key])
        .filter((v) => v !== null && v !== undefined);
      return vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
        : null;
    };
    hours.push({
      start: new Date(t).toISOString(),
      label: DateTime.fromMillis(t, { zone }).toFormat("HH:mm ZZ"),
      activeSeconds: sortedUnionSeconds(activePairs, t, until),
      observedSeconds: sortedUnionSeconds(allPairs, t, until),
      focusSeconds: sortedUnionSeconds(focusPairs, t, until),
      switches: switchTimes.filter((at) => at >= t && at < until).length,
      checkinCount: hourCheckins.length,
      avgFocus: avg("focus"),
      avgStress: avg("stress"),
      avgEnergy: avg("energy"),
    });
  }

  const domains = {};
  const categories = {};
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    const range = activePairsRaw[i];
    const domKey = e.domain;
    domains[domKey] ??= [];
    domains[domKey].push(range);

    const catKey = e.category || "uncategorized";
    categories[catKey] ??= [];
    categories[catKey].push(range);
  }

  return {
    observedSeconds: sortedUnionSeconds(allPairs, start, end),
    activeSeconds: sortedUnionSeconds(activePairs, start, end),
    idleSeconds: sortedUnionSeconds(idlePairs, start, end),
    tabSwitches: switchTimes.filter((at) => at >= start && at < end).length,
    hours,
    domains: Object.entries(domains)
      .map(([domain, ranges]) => ({
        domain,
        seconds: sortedUnionSeconds(ranges.sort(byStart), start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    categories: Object.entries(categories)
      .map(([category, ranges]) => ({
        category,
        seconds: sortedUnionSeconds(ranges.sort(byStart), start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    coverage: null,
    coverageReason:
      "No intended observation schedule is defined. Missing time is not assumed idle.",
  };
}

/**
 * Computes ADHD-informed workflow telemetry metrics:
 * 1. Task Initiation Latency (first_started_at - created_at), partitioned by
 *    decomposed (subtask or parent with subtasks) vs. monolithic tasks.
 * 2. Estimation Calibration (actual recorded work_segments vs. estimated_minutes).
 * 3. Checkpoint Resumption Lag (time between work segments with vs. without a resume note).
 */
export function workflowMetrics(
  tasks = [],
  taskSegments = [],
  checkpoints = [],
) {
  const parentIdsWithChildren = new Set(
    tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id),
  );
  const allLatencies = [];
  const decomposedLatencies = [];
  const monolithicLatencies = [];

  for (const t of tasks) {
    if (!t.created_at || !t.first_started_at) continue;
    const latency = Math.max(
      0,
      (+new Date(t.first_started_at) - +new Date(t.created_at)) / 1000,
    );
    allLatencies.push(latency);
    const isDecomposed =
      Boolean(t.parent_task_id) || parentIdsWithChildren.has(t.id);
    if (isDecomposed) decomposedLatencies.push(latency);
    else monolithicLatencies.push(latency);
  }

  // Group work segments by task_id
  const segsByTask = {};
  for (const s of taskSegments) {
    if (!s.task_id) continue;
    segsByTask[s.task_id] ??= [];
    segsByTask[s.task_id].push([
      +new Date(s.started_at),
      +new Date(s.ended_at),
    ]);
  }

  let plannedSeconds = 0;
  let actualSeconds = 0;
  let calibratedTasks = 0;
  for (const t of tasks) {
    if (!t.estimated_minutes || t.estimated_minutes <= 0) continue;
    const taskActual =
      typeof t.actual_seconds === "number" && !segsByTask[t.id]
        ? t.actual_seconds
        : unionSeconds(segsByTask[t.id] || []);
    if (taskActual > 0 || t.status === "completed") {
      plannedSeconds += t.estimated_minutes * 60;
      actualSeconds += taskActual;
      calibratedTasks += 1;
    }
  }

  // Checkpoint resumption speed: for tasks with multiple work segments, check if a checkpoint
  // was saved during the pause gap [prevEnd, nextStart].
  const checkpointsByTask = {};
  for (const cp of checkpoints) {
    checkpointsByTask[cp.task_id] ??= [];
    checkpointsByTask[cp.task_id].push(+new Date(cp.created_at));
  }
  const withNoteGaps = [];
  const withoutNoteGaps = [];
  for (const [taskId, segs] of Object.entries(segsByTask)) {
    const ordered = [...segs].sort((a, b) => a[0] - b[0]);
    const cpTimes = checkpointsByTask[taskId] || [];
    for (let i = 1; i < ordered.length; i++) {
      const prevEnd = ordered[i - 1][1];
      const nextStart = ordered[i][0];
      if (nextStart <= prevEnd) continue;
      const gapSeconds = (nextStart - prevEnd) / 1000;
      const hadCheckpoint = cpTimes.some(
        (at) => at >= ordered[i - 1][0] && at <= nextStart,
      );
      if (hadCheckpoint) withNoteGaps.push(gapSeconds);
      else withoutNoteGaps.push(gapSeconds);
    }
  }

  return {
    initiation: {
      startedCount: allLatencies.length,
      decomposedCount: decomposedLatencies.length,
      monolithicCount: monolithicLatencies.length,
      medianSeconds: median(allLatencies),
      decomposedMedianSeconds: median(decomposedLatencies),
      monolithicMedianSeconds: median(monolithicLatencies),
    },
    calibration: {
      calibratedTasks,
      plannedSeconds,
      actualSeconds: Math.round(actualSeconds),
      ratio:
        plannedSeconds > 0
          ? Math.round((actualSeconds / plannedSeconds) * 100) / 100
          : null,
    },
    resumption: {
      withNoteCount: withNoteGaps.length,
      withoutNoteCount: withoutNoteGaps.length,
      withNoteMedianSeconds: median(withNoteGaps),
      withoutNoteMedianSeconds: median(withoutNoteGaps),
    },
  };
}
