import assert from "node:assert/strict";
import os from "node:os";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  dayWindow,
  unionSeconds,
  activityReport,
  workflowMetrics,
} from "../src/metrics.js";
import { hashToken } from "../src/security.js";

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 30;

function round2(v) {
  return Math.round(v * 100) / 100;
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((acc, v) => acc + v, 0) / n;
  const variance =
    n > 1 ? s.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1) : 0;
  const q = (p) => s[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    r: n,
    meanMs: round2(mean),
    sdMs: round2(Math.sqrt(variance)),
    p50Ms: round2(q(50)),
    p95Ms: round2(q(95)),
    minMs: round2(s[0]),
    maxMs: round2(s[n - 1]),
  };
}

function measureWorkload(fn, warmup = WARMUP_RUNS, runs = MEASURED_RUNS) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  return { stats: summarize(times), last };
}

async function measureAsyncWorkload(
  fn,
  warmup = WARMUP_RUNS,
  runs = MEASURED_RUNS,
) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  return { stats: summarize(times), last };
}

function generateOverlappingEvents(count, start, end) {
  const events = [];
  const span = end - start;
  const domains = [
    ["scholar.google.com", "study"],
    ["leetcode.com", "study"],
    ["docs.python.org", "study"],
    ["calendar.google.com", "necessary"],
    ["youtube.com", "leisure"],
  ];
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-random offset so runs are reproducible
    const offset = ((i * 7919) % span) - 15000;
    const dur = 5000 + ((i * 104729) % 55000);
    const s = start + offset;
    const e = s + dur;
    const [domain, category] = domains[i % domains.length];
    events.push({
      eventId: `evt-${i}`,
      type: "interval",
      at: new Date(e).toISOString(),
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      state: i % 6 === 0 ? "idle" : "active",
      domain: i % 6 === 0 ? null : domain,
      category,
    });
    if (i % 4 === 0) {
      events.push({
        eventId: `sw-${i}`,
        type: "tab_switch",
        at: new Date(start + ((i * 65537) % span)).toISOString(),
      });
    }
  }
  return events;
}

// Baseline (pre-optimization): re-parses ISO timestamps inside every hour bucket
function activityReportUnhoisted(events, start, end, zone, extra = {}) {
  const intervals = events.filter((e) => e.type === "interval");
  const active = intervals.filter((e) => e.state === "active");
  const idle = intervals.filter((e) => e.state === "idle");
  const pairs = (es) => es.map((e) => [+new Date(e.start), +new Date(e.end)]);
  const checkins = extra.checkins || [];
  const rawSegments = extra.segments || [];

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
      activeSeconds: unionSeconds(pairs(active), t, until),
      observedSeconds: unionSeconds(pairs(intervals), t, until),
      focusSeconds: unionSeconds(
        rawSegments.map((s) => [
          +new Date(s.started_at ?? s[0]),
          +new Date(s.ended_at ?? s[1]),
        ]),
        t,
        until,
      ),
      switches: events.filter((e) => {
        if (e.type !== "tab_switch") return false;
        const at = +new Date(e.at);
        return at >= t && at < until;
      }).length,
      checkinCount: hourCheckins.length,
      avgFocus: avg("focus"),
      avgStress: avg("stress"),
      avgEnergy: avg("energy"),
    });
  }

  const domains = {};
  const categories = {};
  for (const e of active) {
    const range = [+new Date(e.start), +new Date(e.end)];
    domains[e.domain] ??= [];
    domains[e.domain].push(range);
    const catKey = e.category || "uncategorized";
    categories[catKey] ??= [];
    categories[catKey].push(range);
  }

  return {
    observedSeconds: unionSeconds(pairs(intervals), start, end),
    activeSeconds: unionSeconds(pairs(active), start, end),
    idleSeconds: unionSeconds(pairs(idle), start, end),
    tabSwitches: events.filter((e) => {
      if (e.type !== "tab_switch") return false;
      const at = +new Date(e.at);
      return at >= start && at < end;
    }).length,
    hours,
    domains: Object.entries(domains)
      .map(([domain, ranges]) => ({
        domain,
        seconds: unionSeconds(ranges, start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    categories: Object.entries(categories)
      .map(([category, ranges]) => ({
        category,
        seconds: unionSeconds(ranges, start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    coverage: null,
    coverageReason:
      "No intended observation schedule is defined. Missing time is not assumed idle.",
  };
}

// Intermediate variant: hoists pair parsing once before loop, still sorts inside each hour
function activityReportHoistedPerHour(events, start, end, zone, extra = {}) {
  const intervals = events.filter((e) => e.type === "interval");
  const active = intervals.filter((e) => e.state === "active");
  const idle = intervals.filter((e) => e.state === "idle");
  const pairs = (es) => es.map((e) => [+new Date(e.start), +new Date(e.end)]);
  const allPairs = pairs(intervals);
  const activePairs = pairs(active);
  const idlePairs = pairs(idle);
  const switchTimes = events
    .filter((e) => e.type === "tab_switch")
    .map((e) => +new Date(e.at));
  const focusPairs = (extra.segments || []).map((s) => [
    +new Date(s.started_at ?? s[0]),
    +new Date(s.ended_at ?? s[1]),
  ]);
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
      activeSeconds: unionSeconds(activePairs, t, until),
      observedSeconds: unionSeconds(allPairs, t, until),
      focusSeconds: unionSeconds(focusPairs, t, until),
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
    const range = activePairs[i];
    domains[e.domain] ??= [];
    domains[e.domain].push(range);
    const catKey = e.category || "uncategorized";
    categories[catKey] ??= [];
    categories[catKey].push(range);
  }

  return {
    observedSeconds: unionSeconds(allPairs, start, end),
    activeSeconds: unionSeconds(activePairs, start, end),
    idleSeconds: unionSeconds(idlePairs, start, end),
    tabSwitches: switchTimes.filter((at) => at >= start && at < end).length,
    hours,
    domains: Object.entries(domains)
      .map(([domain, ranges]) => ({
        domain,
        seconds: unionSeconds(ranges, start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    categories: Object.entries(categories)
      .map(([category, ranges]) => ({
        category,
        seconds: unionSeconds(ranges, start, end),
      }))
      .sort((a, b) => b.seconds - a.seconds),
    coverage: null,
    coverageReason:
      "No intended observation schedule is defined. Missing time is not assumed idle.",
  };
}

function assertIntervalInvariants(report) {
  for (const h of report.hours) {
    assert.ok(
      h.activeSeconds >= 0 && h.activeSeconds <= 3600,
      `Hourly active bound violated: ${h.activeSeconds}`,
    );
    assert.ok(
      h.observedSeconds >= h.activeSeconds && h.observedSeconds <= 3600,
      `Hourly observed bound violated: ${h.observedSeconds}`,
    );
  }
  assert.ok(
    report.activeSeconds <= report.observedSeconds,
    "Daily active exceeded observed",
  );
}

// 1. Interval Merging & Daily Report Scaling Benchmark (Unhoisted vs Hoisted vs Sort-Once)
function runIntervalBenchmarks() {
  const { start, end } = dayWindow("2026-10-29", "Asia/Kolkata");
  const sizes = [100, 1000, 5000, 10000];
  const rows = [];

  for (const n of sizes) {
    const dataset = generateOverlappingEvents(n, start, end);
    if (n === 1000) {
      const ref = activityReport(dataset, start, end, "Asia/Kolkata");
      assert.deepStrictEqual(
        activityReportUnhoisted(dataset, start, end, "Asia/Kolkata"),
        ref,
      );
      assert.deepStrictEqual(
        activityReportHoistedPerHour(dataset, start, end, "Asia/Kolkata"),
        ref,
      );
    }

    const u = measureWorkload(() =>
      activityReportUnhoisted(dataset, start, end, "Asia/Kolkata"),
    );
    const h = measureWorkload(() =>
      activityReportHoistedPerHour(dataset, start, end, "Asia/Kolkata"),
    );
    const s = measureWorkload(() =>
      activityReport(dataset, start, end, "Asia/Kolkata"),
    );

    assertIntervalInvariants(u.last);
    assertIntervalInvariants(h.last);
    assertIntervalInvariants(s.last);

    rows.push(
      {
        workload: `Activity report unhoisted (${n.toLocaleString()})`,
        variant: "unhoisted",
        n,
        ...u.stats,
        invariantViolations: 0,
      },
      {
        workload: `Activity report hoisted (${n.toLocaleString()})`,
        variant: "hoisted",
        n,
        ...h.stats,
        invariantViolations: 0,
      },
      {
        workload: `Activity report sort-once (${n.toLocaleString()})`,
        variant: "sortOnce",
        n,
        ...s.stats,
        invariantViolations: 0,
      },
    );
  }
  return rows;
}

// 2. Focus-start protocol model (in-memory serialized lock, 200 concurrent promises/run)
async function runFocusConcurrencyBenchmark() {
  let violations = 0;

  async function oneRun() {
    let lock = Promise.resolve();
    const withAdvisoryLock = (fn) => {
      const next = lock.then(fn, fn);
      lock = next.catch(() => {});
      return next;
    };
    const sessions = [];
    const byRequestKey = new Map();

    const startSession = ({ taskId, minutes, requestKey }) =>
      withAdvisoryLock(async () => {
        await Promise.resolve();
        const old = byRequestKey.get(requestKey);
        if (old) {
          if (old.taskId !== taskId || old.plannedSeconds !== minutes * 60) {
            throw Object.assign(new Error("Request key conflict"), {
              status: 409,
            });
          }
          return old;
        }
        const busy = sessions.find((s) => s.status !== "finished");
        if (busy) {
          throw Object.assign(new Error("Active session exists"), {
            status: 409,
          });
        }
        const created = {
          id: randomUUID(),
          taskId,
          plannedSeconds: minutes * 60,
          status: "active",
          requestKey,
        };
        sessions.push(created);
        byRequestKey.set(requestKey, created);
        if (sessions.filter((s) => s.status !== "finished").length > 1) {
          violations += 1;
        }
        return created;
      });

    const sharedKey = randomUUID();
    const taskId = randomUUID();
    const outcomes = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const key = i < 50 ? sharedKey : randomUUID();
        return startSession({ taskId, minutes: 25, requestKey: key })
          .then((res) => ({ ok: true, id: res.id, shared: i < 50 }))
          .catch((err) => ({ ok: false, status: err.status, shared: i < 50 }));
      }),
    );
    const sharedOk = outcomes.filter((o) => o.shared && o.ok);
    const distinct409 = outcomes.filter(
      (o) => !o.shared && !o.ok && o.status === 409,
    );
    assert.equal(sharedOk.length, 50);
    assert.equal(new Set(sharedOk.map((o) => o.id)).size, 1);
    assert.equal(distinct409.length, 150);
  }

  const { stats } = await measureAsyncWorkload(oneRun);
  assert.equal(violations, 0);
  return {
    workload: "Focus-start protocol model (in-memory serialized lock, 200 reqs)",
    variant: "inMemoryModel",
    ...stats,
    invariantViolations: violations,
  };
}

// 3. Consent gate predicate (in-memory, 500 batches/run)
function runConsentEpochBenchmark() {
  let violations = 0;

  function oneRun() {
    let device = { tracking_enabled: true, consent_epoch: 1 };
    const store = new Map();
    let staleRejected = 0;
    for (let i = 0; i < 500; i++) {
      if (i > 0 && i % 50 === 0) {
        device.tracking_enabled = !device.tracking_enabled;
        device.consent_epoch += 1;
        if (!device.tracking_enabled) store.clear();
      }
      const batchEpoch =
        i % 3 === 0 ? Math.max(0, device.consent_epoch - 1) : device.consent_epoch;
      const payload = {
        eventId: `e-${Math.floor(i / 2)}`,
        domain: "scholar.google.com",
        epoch: batchEpoch,
      };
      const digest = hashToken(JSON.stringify(payload));
      if (!device.tracking_enabled || batchEpoch !== device.consent_epoch) {
        staleRejected += 1;
      } else {
        const existing = store.get(payload.eventId);
        if (existing && existing.digest !== digest) violations += 1;
        else store.set(payload.eventId, { ...payload, digest });
      }
    }
    for (const doc of store.values()) {
      if (doc.epoch !== device.consent_epoch || !device.tracking_enabled) {
        violations += 1;
      }
    }
    assert.ok(staleRejected > 150);
  }

  const { stats } = measureWorkload(oneRun);
  assert.equal(violations, 0);
  return {
    workload: "Consent gate predicate (in-memory, 500 batches)",
    variant: "inMemoryModel",
    ...stats,
    invariantViolations: violations,
  };
}

// 4. Workflow Executive-Function Telemetry Benchmark (1,000 tasks, 2,000 segments)
function runWorkflowTelemetryBenchmark() {
  const base = Date.parse("2026-10-01T08:00:00Z");
  const tasks = [];
  const segments = [];
  const checkpoints = [];

  for (let i = 0; i < 1000; i++) {
    const id = `task-${i}`;
    const parentId = i % 3 !== 0 ? `task-${i - (i % 3)}` : null;
    const created = base + i * 60000;
    const latency = (parentId ? 180 : 900) * 1000 + (i % 120) * 1000;
    const started = created + latency;
    tasks.push({
      id,
      parent_task_id: parentId,
      status: i % 2 === 0 ? "completed" : "in_progress",
      estimated_minutes: 25,
      created_at: new Date(created).toISOString(),
      first_started_at: new Date(started).toISOString(),
    });
    segments.push(
      {
        task_id: id,
        started_at: new Date(started).toISOString(),
        ended_at: new Date(started + 900000).toISOString(),
      },
      {
        task_id: id,
        started_at: new Date(
          started + 900000 + (i % 2 === 0 ? 180000 : 600000),
        ).toISOString(),
        ended_at: new Date(started + 1800000).toISOString(),
      },
    );
    if (i % 2 === 0) {
      checkpoints.push({
        task_id: id,
        created_at: new Date(started + 910000).toISOString(),
      });
    }
  }

  const { stats, last: result } = measureWorkload(() =>
    workflowMetrics(tasks, segments, checkpoints),
  );
  assert.equal(result.initiation.startedCount, 1000);
  assert.ok(
    result.initiation.decomposedMedianSeconds <
      result.initiation.monolithicMedianSeconds,
  );
  assert.ok(
    result.resumption.withNoteMedianSeconds <
      result.resumption.withoutNoteMedianSeconds,
  );

  return {
    workload: "Workflow telemetry (1,000 tasks, 2,000 segments)",
    variant: "workflowMetrics",
    ...stats,
    invariantViolations: 0,
  };
}

const environment = {
  cpuModel: os.cpus()[0]?.model || "unknown",
  cpuCores: os.cpus().length,
  totalMemGiB: round2(os.totalmem() / 1024 ** 3),
  nodeVersion: process.version,
  osPlatform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  warmupRuns: WARMUP_RUNS,
  measuredRuns: MEASURED_RUNS,
};

const results = [
  ...runIntervalBenchmarks(),
  await runFocusConcurrencyBenchmark(),
  runConsentEpochBenchmark(),
  runWorkflowTelemetryBenchmark(),
];

const payload = {
  generatedAt: new Date().toISOString(),
  environment,
  results,
};

writeFileSync(
  new URL("./benchmark-results.json", import.meta.url),
  JSON.stringify(payload, null, 2) + "\n",
);

console.log("\n=== Steady Systems & Invariant Benchmark Summary ===");
console.log("Environment:", environment);
console.table(
  results.map(({ variant, n, ...display }) => display),
);
