import test from "node:test";
import assert from "node:assert/strict";
import {
  unionSeconds,
  dayWindow,
  activityReport,
  workflowMetrics,
} from "../src/metrics.js";
import {
  passwordHash,
  passwordMatches,
  hashToken,
  token,
  safeEqual,
} from "../src/security.js";

test("overlapping devices do not double count total active time", () =>
  assert.equal(
    unionSeconds(
      [
        [0, 10000],
        [5000, 15000],
        [20000, 30000],
      ],
      7000,
      25000,
    ),
    13,
  ));

test("empty and inverted intervals contribute zero", () =>
  assert.equal(
    unionSeconds([
      [20, 10],
      [0, 0],
    ]),
    0,
  ));

test("local dates account for daylight saving changes", () => {
  for (const [date, h] of [
    ["2026-03-08", 23],
    ["2026-11-01", 25],
  ]) {
    const w = dayWindow(date, "America/New_York");
    assert.equal((w.end - w.start) / 3600000, h);
  }
});

test("invalid dates are rejected", () =>
  assert.throws(() => dayWindow("2026-02-30", "UTC")));

test("report clips intervals at midnight, aggregates categories, and overlays focus/checkins", () => {
  const { start, end } = dayWindow("2026-10-29", "Asia/Kolkata");
  const iso = (n) => new Date(n).toISOString();
  const r = activityReport(
    [
      {
        type: "interval",
        start: iso(start - 10000),
        end: iso(start + 20000),
        state: "active",
        domain: "example.org",
        category: "study",
      },
      {
        type: "interval",
        start: iso(start + 10000),
        end: iso(start + 30000),
        state: "active",
        domain: "docs.example.org",
        category: "study",
      },
      { type: "tab_switch", at: iso(start) },
      { type: "tab_switch", at: iso(end) },
    ],
    start,
    end,
    "Asia/Kolkata",
    {
      segments: [
        { started_at: iso(start + 5000), ended_at: iso(start + 45000) },
      ],
      checkins: [
        { recorded_at: iso(start + 15000), focus: 4, stress: 2, energy: 3 },
      ],
    },
  );
  assert.equal(r.activeSeconds, 30);
  assert.equal(r.tabSwitches, 1);
  assert.equal(r.hours.length, 24);
  assert.equal(r.hours[0].focusSeconds, 40);
  assert.equal(r.hours[0].checkinCount, 1);
  assert.equal(r.hours[0].avgFocus, 4);
  assert.equal(r.coverage, null);
  assert.equal(r.domains[0].seconds, 20);
  assert.equal(r.categories.length, 1);
  assert.equal(r.categories[0].category, "study");
  assert.equal(r.categories[0].seconds, 30);
});

test("workflowMetrics computes initiation latency, calibration ratio, and checkpoint resumption lag", () => {
  const t0 = Date.parse("2026-10-29T08:00:00Z");
  const iso = (offsetSec) => new Date(t0 + offsetSec * 1000).toISOString();

  const tasks = [
    // Parent task with subtask (decomposed): started after 120s, estimated 20m
    {
      id: "parent-1",
      parent_task_id: null,
      status: "completed",
      estimated_minutes: 20,
      created_at: iso(0),
      first_started_at: iso(120),
    },
    // Subtask (decomposed): started after 60s, estimated 10m
    {
      id: "sub-1",
      parent_task_id: "parent-1",
      status: "completed",
      estimated_minutes: 10,
      created_at: iso(0),
      first_started_at: iso(60),
    },
    // Monolithic task (no subtasks): started after 600s, estimated 10m
    {
      id: "mono-1",
      parent_task_id: null,
      status: "in_progress",
      estimated_minutes: 10,
      created_at: iso(0),
      first_started_at: iso(600),
    },
  ];

  const segments = [
    // parent-1: two 600s segments separated by a 180s pause (with checkpoint at t=700s)
    { task_id: "parent-1", started_at: iso(120), ended_at: iso(720) },
    { task_id: "parent-1", started_at: iso(900), ended_at: iso(1500) },
    // sub-1: one 600s segment
    { task_id: "sub-1", started_at: iso(60), ended_at: iso(660) },
    // mono-1: two 300s segments separated by a 500s pause (no checkpoint)
    { task_id: "mono-1", started_at: iso(600), ended_at: iso(900) },
    { task_id: "mono-1", started_at: iso(1400), ended_at: iso(1700) },
  ];

  const checkpoints = [{ task_id: "parent-1", created_at: iso(715) }];

  const w = workflowMetrics(tasks, segments, checkpoints);
  assert.equal(w.initiation.startedCount, 3);
  assert.equal(w.initiation.decomposedCount, 2);
  assert.equal(w.initiation.monolithicCount, 1);
  assert.equal(w.initiation.decomposedMedianSeconds, 90);
  assert.equal(w.initiation.monolithicMedianSeconds, 600);

  // Total planned = (20 + 10 + 10) * 60 = 2400s; total actual = 1200 + 600 + 600 = 2400s
  assert.equal(w.calibration.calibratedTasks, 3);
  assert.equal(w.calibration.plannedSeconds, 2400);
  assert.equal(w.calibration.actualSeconds, 2400);
  assert.equal(w.calibration.ratio, 1);

  // Resumption: with note = 180s, without note = 500s
  assert.equal(w.resumption.withNoteCount, 1);
  assert.equal(w.resumption.withNoteMedianSeconds, 180);
  assert.equal(w.resumption.withoutNoteCount, 1);
  assert.equal(w.resumption.withoutNoteMedianSeconds, 500);
});

test("passwords use random salts and reject incorrect input", async () => {
  const a = await passwordHash("a long password"),
    b = await passwordHash("a long password");
  assert.notEqual(a, b);
  assert.equal(await passwordMatches("a long password", a), true);
  assert.equal(await passwordMatches("wrong", a), false);
});

test("tokens are unpredictable and stored as digests", () => {
  const a = token(),
    b = token();
  assert.notEqual(a, b);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
});

test("safeEqual compares UTF-8 strings in constant time", () => {
  const t = token();
  assert.equal(safeEqual(t, t), true);
  assert.equal(safeEqual(t, t.slice(0, -1)), false);
  assert.equal(safeEqual(t, "x" + t.slice(1)), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual(t, null), false);
});
