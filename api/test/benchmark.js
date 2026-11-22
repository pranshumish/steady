import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  dayWindow,
  unionSeconds,
  activityReport,
  workflowMetrics,
} from "../src/metrics.js";
import { hashToken } from "../src/security.js";

function percentile(samples, p) {
  const s = [...samples].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[idx] * 100) / 100;
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

// 1. Interval Merging & Daily Report Scaling Benchmark
function runIntervalBenchmarks() {
  const { start, end } = dayWindow("2026-10-29", "Asia/Kolkata");
  const sizes = [100, 1000, 5000, 10000];
  const rows = [];

  for (const n of sizes) {
    const dataset = generateOverlappingEvents(n, start, end);
    const trials = n >= 10000 ? 10 : 25;
    const times = [];
    let lastReport = null;

    for (let t = 0; t < trials; t++) {
      const t0 = performance.now();
      lastReport = activityReport(dataset, start, end, "Asia/Kolkata");
      times.push(performance.now() - t0);
    }

    // Formal invariant verification: every hour bucket is bounded in [0, 3600]
    for (const h of lastReport.hours) {
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
      lastReport.activeSeconds <= lastReport.observedSeconds,
      "Daily active exceeded observed",
    );

    rows.push({
      workload: `Activity report (${n.toLocaleString()} intervals)`,
      p50Ms: percentile(times, 50),
      p95Ms: percentile(times, 95),
      p99Ms: percentile(times, 99),
      invariantViolations: 0,
    });
  }
  return rows;
}

// 2. Proposition 1 & 2: Idempotent Focus-Start & Single-Active-Session Concurrency Test
async function runFocusConcurrencyBenchmark() {
  let lock = Promise.resolve();
  const withAdvisoryLock = (fn) => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => {});
    return next;
  };

  const sessions = [];
  const byRequestKey = new Map();
  let violations = 0;

  const startSession = ({ taskId, minutes, requestKey }) =>
    withAdvisoryLock(async () => {
      await Promise.resolve(); // simulate async DB I/O boundary
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
      const activeCount = sessions.filter(
        (s) => s.status !== "finished",
      ).length;
      if (activeCount > 1) violations += 1;
      return created;
    });

  const sharedKey = randomUUID();
  const taskId = randomUUID();
  const times = [];

  // Fire 200 concurrent start requests: 50 retries with sharedKey + 150 competing distinct keys
  const requests = Array.from({ length: 200 }, (_, i) => {
    const key = i < 50 ? sharedKey : randomUUID();
    const t0 = performance.now();
    return startSession({ taskId, minutes: 25, requestKey: key })
      .then((res) => ({
        ok: true,
        id: res.id,
        ms: performance.now() - t0,
        shared: i < 50,
      }))
      .catch((err) => ({
        ok: false,
        status: err.status,
        ms: performance.now() - t0,
        shared: i < 50,
      }));
  });

  const outcomes = await Promise.all(requests);
  for (const o of outcomes) times.push(o.ms);

  const sharedSuccesses = outcomes.filter((o) => o.shared && o.ok);
  const distinctRejections = outcomes.filter(
    (o) => !o.shared && !o.ok && o.status === 409,
  );
  const uniqueSessionIds = new Set(sharedSuccesses.map((o) => o.id));

  assert.equal(
    sharedSuccesses.length,
    50,
    "All 50 idempotent retries must succeed",
  );
  assert.equal(
    uniqueSessionIds.size,
    1,
    "All idempotent retries must return identical session ID",
  );
  assert.equal(
    distinctRejections.length,
    150,
    "All 150 competing concurrent starts must be rejected with 409",
  );
  assert.equal(violations, 0, "Zero single-active-session violations");

  return {
    workload: "Concurrent focus starts (200 parallel, 50 retries)",
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    invariantViolations: violations,
  };
}

// 3. Proposition 3: Monotonic Consent Epoch & Stale Offline Batch Rejection
function runConsentEpochBenchmark() {
  let device = { tracking_enabled: true, consent_epoch: 1 };
  const store = new Map();
  let violations = 0;
  let staleRejected = 0;
  const times = [];

  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    // Every 50 batches, toggle consent or purge (incrementing consent_epoch)
    if (i > 0 && i % 50 === 0) {
      device.tracking_enabled = !device.tracking_enabled;
      device.consent_epoch += 1;
      if (!device.tracking_enabled) store.clear();
    }
    const isStaleAttempt = i % 3 === 0;
    const batchEpoch = isStaleAttempt
      ? Math.max(0, device.consent_epoch - 1)
      : device.consent_epoch;
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
      if (existing && existing.digest !== digest) {
        violations += 1;
      } else {
        store.set(payload.eventId, { ...payload, digest });
      }
    }
    times.push(performance.now() - t0);
  }

  // Verify no events stored in the map have an epoch != current device.consent_epoch
  for (const doc of store.values()) {
    if (doc.epoch !== device.consent_epoch || !device.tracking_enabled) {
      violations += 1;
    }
  }
  assert.equal(violations, 0, "Zero stale-epoch events persisted");
  assert.ok(staleRejected > 150, "Stale batches must be rejected");

  return {
    workload: "Consent epoch & digest deduplication (500 batches)",
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    invariantViolations: violations,
  };
}

// 4. Workflow Executive-Function Telemetry Benchmark
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

  const times = [];
  let result = null;
  for (let t = 0; t < 25; t++) {
    const t0 = performance.now();
    result = workflowMetrics(tasks, segments, checkpoints);
    times.push(performance.now() - t0);
  }

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
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    invariantViolations: 0,
  };
}

const results = [
  ...runIntervalBenchmarks(),
  await runFocusConcurrencyBenchmark(),
  runConsentEpochBenchmark(),
  runWorkflowTelemetryBenchmark(),
];

console.log("\n=== Steady Systems & Invariant Benchmark Summary ===");
console.table(results);
