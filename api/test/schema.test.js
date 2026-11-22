/**
 * Database-level tests. These execute the real SQL migrations on PGlite
 * (PostgreSQL 17 compiled to WebAssembly), so constraints, triggers, exclusion
 * constraints, generated columns and views are exercised by a real planner.
 * This is NOT a substitute for the Docker integration test, which also covers
 * MongoDB, the HTTP layer and the extension.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { loadMigrations } from "../src/migrations.js";
import { eraseAccount, ERASURE_ORDER } from "../src/erasure.js";

let db;
let counter = 0;

before(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  for (const m of await loadMigrations()) {
    // pgcrypto is not bundled with PGlite; gen_random_uuid() is core in PG13+.
    await db.exec(m.sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    if (!m.baseline)
      await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        m.version,
      ]);
  }
});
after(async () => {
  await db.close();
});

const q = (sql, params) => db.query(sql, params);
const rejects = (p, re) =>
  assert.rejects(p, (e) => re.test(e.message), `expected rejection ${re}`);

async function makeUser() {
  counter += 1;
  const {
    rows: [u],
  } = await q(
    "INSERT INTO users(email,password_hash,display_name,timezone) VALUES($1,'x','Test User','UTC') RETURNING id,email",
    [`user${counter}@example.test`],
  );
  return u;
}
async function makeTask(u, title = "Task", extra = {}) {
  const {
    rows: [t],
  } = await q(
    "INSERT INTO tasks(user_id,title,project_id,parent_task_id,estimated_minutes) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [
      u.id,
      title,
      extra.project_id ?? null,
      extra.parent_task_id ?? null,
      extra.estimated_minutes ?? null,
    ],
  );
  return t;
}
async function makeSession(u, t, status = "finished") {
  const {
    rows: [s],
  } = await q(
    `INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key,ended_at)
     VALUES($1,$2,1500,$3,$4,CASE WHEN $3='finished' THEN now()+interval '1 hour' ELSE NULL END) RETURNING *`,
    [u.id, t.id, status, randomUUID()],
  );
  return s;
}
const segment = (u, s, from, to) =>
  q(
    "INSERT INTO work_segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,$3,$4) RETURNING *",
    [u.id, s.id, from, to],
  );

test("migrations create the reference tables, views and audit table", async () => {
  const { rows } = await q(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
  );
  const names = rows.map((r) => r.table_name);
  for (const t of [
    "task_statuses",
    "task_event_types",
    "activity_categories",
    "auth_events",
  ])
    assert.ok(names.includes(t), `${t} missing`);
  assert.equal(names.length, 20);
  const { rows: views } = await q(
    "SELECT table_name FROM information_schema.views WHERE table_schema='public'",
  );
  assert.deepEqual(views.map((v) => v.table_name).sort(), [
    "v_consent_epoch_drift",
    "v_task_continuity",
  ]);
  const { rows: terminal } = await q(
    "SELECT code FROM task_statuses WHERE is_terminal ORDER BY code",
  );
  assert.deepEqual(
    terminal.map((r) => r.code),
    ["abandoned", "completed"],
  );
});

test("composite owner-aware foreign keys block cross-tenant references", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const {
    rows: [p],
  } = await q(
    "INSERT INTO projects(user_id,name) VALUES($1,'A project') RETURNING *",
    [a.id],
  );
  await rejects(
    makeTask(b, "Steals project", { project_id: p.id }),
    /foreign key constraint/,
  );
  const aTask = await makeTask(a, "A task");
  await rejects(
    q(
      "INSERT INTO task_checkpoints(user_id,task_id,resume_note) VALUES($1,$2,'x')",
      [b.id, aTask.id],
    ),
    /foreign key constraint/,
  );
});

test("status values are constrained by the lookup table", async () => {
  const u = await makeUser();
  await rejects(
    q("INSERT INTO tasks(user_id,title,status) VALUES($1,'Bad','bogus')", [u.id]),
    /tasks_status_fk/,
  );
  const t = await makeTask(u);
  await rejects(
    q(
      "INSERT INTO task_events(user_id,task_id,event_type,new_status) VALUES($1,$2,'status_changed','bogus')",
      [u.id, t.id],
    ),
    /task_events_new_status_fk/,
  );
  await rejects(
    q(
      "INSERT INTO task_events(user_id,task_id,event_type) VALUES($1,$2,'made_up')",
      [u.id, t.id],
    ),
    /task_events_type_fk/,
  );
});

test("declarative CHECK constraints reject invalid rows", async () => {
  const u = await makeUser();
  await rejects(
    q("INSERT INTO tasks(user_id,title) VALUES($1,'   ')", [u.id]),
    /tasks_title_valid/,
  );
  await rejects(
    q("INSERT INTO tasks(user_id,title,estimated_minutes) VALUES($1,'x',481)", [
      u.id,
    ]),
    /check constraint/,
  );
  await rejects(
    q(
      "INSERT INTO tasks(user_id,title,status) VALUES($1,'done but no timestamp','completed')",
      [u.id],
    ),
    /tasks_completion_consistent/,
  );
  await rejects(
    q(
      "INSERT INTO users(email,password_hash,display_name) VALUES('not-an-email','x','N')",
    ),
    /users_email_shape/,
  );
  await rejects(
    q("INSERT INTO checkins(user_id,focus) VALUES($1,6)", [u.id]),
    /check constraint/,
  );
  await rejects(
    q("INSERT INTO checkins(user_id) VALUES($1)", [u.id]),
    /check constraint/,
  );
});

test("the one-level subtask rule is enforced by a trigger", async () => {
  const u = await makeUser();
  const parent = await makeTask(u, "Parent");
  const child = await makeTask(u, "Child", { parent_task_id: parent.id });
  await rejects(
    makeTask(u, "Grandchild", { parent_task_id: child.id }),
    /one level only/,
  );
  // re-parenting a leaf under another root is allowed
  const other = await makeTask(u, "Other");
  await q("UPDATE tasks SET parent_task_id=$1 WHERE id=$2", [other.id, child.id]);
  // a task that already owns subtasks cannot itself become a subtask
  await rejects(
    q("UPDATE tasks SET parent_task_id=$1 WHERE id=$2", [parent.id, other.id]),
    /cannot become a subtask/,
  );
});

test("only one unfinished session and one open segment per user", async () => {
  const u = await makeUser();
  const t1 = await makeTask(u, "One");
  const t2 = await makeTask(u, "Two");
  const first = await makeSession(u, t1, "active");
  await rejects(makeSession(u, t2, "active"), /one_unfinished_session/);
  await q(
    "INSERT INTO work_segments(user_id,session_id,started_at) VALUES($1,$2,now())",
    [u.id, first.id],
  );
  await rejects(
    q(
      "INSERT INTO work_segments(user_id,session_id,started_at) VALUES($1,$2,now()+interval '1 minute')",
      [u.id, first.id],
    ),
    /one_open_segment|no_overlap/,
  );
});

test("an EXCLUDE constraint forbids overlapping work segments per user", async () => {
  const u = await makeUser();
  const v = await makeUser();
  const s = await makeSession(u, await makeTask(u));
  const sv = await makeSession(v, await makeTask(v));
  await segment(u, s, "2026-05-01T10:00:00Z", "2026-05-01T11:00:00Z");
  await rejects(
    segment(u, s, "2026-05-01T10:30:00Z", "2026-05-01T11:30:00Z"),
    /work_segments_no_overlap/,
  );
  // half-open ranges: touching boundaries are allowed
  await segment(u, s, "2026-05-01T11:00:00Z", "2026-05-01T12:00:00Z");
  // a different user may overlap in time
  await segment(v, sv, "2026-05-01T10:30:00Z", "2026-05-01T11:30:00Z");
});

test("segment duration is a stored generated column", async () => {
  const u = await makeUser();
  const s = await makeSession(u, await makeTask(u));
  const {
    rows: [seg],
  } = await segment(u, s, "2026-06-01T10:00:00Z", "2026-06-01T10:30:00Z");
  assert.equal(seg.duration_seconds, 1800);
  await rejects(
    q("UPDATE work_segments SET duration_seconds=5 WHERE id=$1", [seg.id]),
    /can only be updated to DEFAULT|generated column/i,
  );
});

test("history tables are append-only except during account erasure", async () => {
  const u = await makeUser();
  const t = await makeTask(u);
  const {
    rows: [e],
  } = await q(
    "INSERT INTO task_events(user_id,task_id,event_type,new_status) VALUES($1,$2,'created','planned') RETURNING *",
    [u.id, t.id],
  );
  await rejects(
    q("UPDATE task_events SET new_status='completed' WHERE id=$1", [e.id]),
    /append-only/,
  );
  await rejects(q("DELETE FROM task_events WHERE id=$1", [e.id]), /append-only/);
  const {
    rows: [k],
  } = await q(
    "INSERT INTO task_checkpoints(user_id,task_id,resume_note) VALUES($1,$2,'note') RETURNING *",
    [u.id, t.id],
  );
  await rejects(
    q("UPDATE task_checkpoints SET resume_note='edited' WHERE id=$1", [k.id]),
    /append-only/,
  );
  // the erasure flag permits DELETE only; an UPDATE is still rejected
  // (a failed statement aborts its transaction, so it gets its own one)
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("SET LOCAL steady.allow_erasure='on'");
      await tx.query("UPDATE task_events SET new_status='completed' WHERE id=$1", [
        e.id,
      ]);
    }),
    /append-only/,
  );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL steady.allow_erasure='on'");
    await tx.query("DELETE FROM task_events WHERE id=$1", [e.id]);
  });
});

test("consent ledger is append-only", async () => {
  const u = await makeUser();
  const {
    rows: [d],
  } = await q(
    "INSERT INTO devices(user_id,label,token_hash) VALUES($1,'Chrome',$2) RETURNING *",
    [u.id, randomUUID()],
  );
  const {
    rows: [c],
  } = await q(
    "INSERT INTO consent_events(user_id,device_id,granted,epoch) VALUES($1,$2,true,1) RETURNING *",
    [u.id, d.id],
  );
  await rejects(
    q("UPDATE consent_events SET granted=false WHERE id=$1", [c.id]),
    /append-only/,
  );
  await rejects(
    q("DELETE FROM consent_events WHERE id=$1", [c.id]),
    /append-only/,
  );
});

test("frozen plans and memberships are immutable", async () => {
  const u = await makeUser();
  const t = await makeTask(u, "Planned", { estimated_minutes: 25 });
  const {
    rows: [p],
  } = await q(
    "INSERT INTO daily_plans(user_id,plan_date,timezone,revision) VALUES($1,'2026-07-01','UTC',1) RETURNING *",
    [u.id],
  );
  await q(
    "INSERT INTO plan_tasks(user_id,plan_id,task_id,position,planned_minutes) VALUES($1,$2,$3,0,25)",
    [u.id, p.id, t.id],
  );
  await q("UPDATE daily_plans SET frozen_at=now() WHERE id=$1", [p.id]);
  await rejects(
    q("UPDATE plan_tasks SET planned_minutes=99 WHERE plan_id=$1", [p.id]),
    /immutable/,
  );
  await rejects(q("DELETE FROM plan_tasks WHERE plan_id=$1", [p.id]), /immutable/);
  await rejects(q("DELETE FROM daily_plans WHERE id=$1", [p.id]), /immutable/);
  await rejects(
    q("UPDATE daily_plans SET revision=2 WHERE id=$1", [p.id]),
    /immutable/,
  );
});

test("v_task_continuity derives time, latency, subtasks and latest note", async () => {
  const u = await makeUser();
  const t = await makeTask(u, "Essay", { estimated_minutes: 30 });
  await makeTask(u, "Outline", { parent_task_id: t.id });
  await q(
    "UPDATE tasks SET first_started_at=created_at+interval '120 seconds' WHERE id=$1",
    [t.id],
  );
  const s = await makeSession(u, t);
  await segment(u, s, "2026-08-01T10:00:00Z", "2026-08-01T10:10:00Z");
  await segment(u, s, "2026-08-01T10:20:00Z", "2026-08-01T10:25:00Z");
  await q(
    "INSERT INTO task_checkpoints(user_id,task_id,resume_note,created_at) VALUES($1,$2,'older','2026-08-01T10:11:00Z'),($1,$2,'newest','2026-08-01T10:26:00Z')",
    [u.id, t.id],
  );
  const {
    rows: [v],
  } = await q("SELECT * FROM v_task_continuity WHERE task_id=$1 AND user_id=$2", [
    t.id,
    u.id,
  ]);
  assert.equal(v.actual_seconds, 900);
  assert.equal(v.segment_count, 2);
  assert.equal(v.subtask_count, 1);
  assert.equal(v.initiation_latency_seconds, 120);
  assert.equal(v.latest_note, "newest");
});

test("v_consent_epoch_drift detects divergence from the consent ledger", async () => {
  const u = await makeUser();
  const {
    rows: [d],
  } = await q(
    "INSERT INTO devices(user_id,label,token_hash) VALUES($1,'Chrome',$2) RETURNING *",
    [u.id, randomUUID()],
  );
  let r = await q("SELECT * FROM v_consent_epoch_drift WHERE device_id=$1", [d.id]);
  assert.equal(r.rows.length, 0);
  await q("INSERT INTO consent_events(user_id,device_id,granted,epoch) VALUES($1,$2,true,1)", [u.id, d.id]);
  await q("UPDATE devices SET tracking_enabled=true,consent_epoch=1 WHERE id=$1", [d.id]);
  r = await q("SELECT * FROM v_consent_epoch_drift WHERE device_id=$1", [d.id]);
  assert.equal(r.rows.length, 0);
  await q("UPDATE devices SET consent_epoch=5 WHERE id=$1", [d.id]);
  r = await q("SELECT * FROM v_consent_epoch_drift WHERE device_id=$1", [d.id]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ledger_epoch, 1);
});

async function populate(u) {
  const {
    rows: [project],
  } = await q("INSERT INTO projects(user_id,name) VALUES($1,'P') RETURNING *", [u.id]);
  const parent = await makeTask(u, "Parent", {
    project_id: project.id,
    estimated_minutes: 20,
  });
  await makeTask(u, "Child", { parent_task_id: parent.id });
  const {
    rows: [ev],
  } = await q(
    "INSERT INTO task_events(user_id,task_id,event_type,new_status) VALUES($1,$2,'created','planned') RETURNING *",
    [u.id, parent.id],
  );
  await q(
    "INSERT INTO outbox_events(user_id,task_event_id,event_type,payload) VALUES($1,$2,'created','{}')",
    [u.id, ev.id],
  );
  const {
    rows: [plan],
  } = await q(
    "INSERT INTO daily_plans(user_id,plan_date,timezone,revision) VALUES($1,'2026-09-01','UTC',1) RETURNING *",
    [u.id],
  );
  await q(
    "INSERT INTO plan_tasks(user_id,plan_id,task_id,position) VALUES($1,$2,$3,0)",
    [u.id, plan.id, parent.id],
  );
  await q("UPDATE daily_plans SET frozen_at=now() WHERE id=$1", [plan.id]);
  const s = await makeSession(u, parent);
  await segment(u, s, "2026-09-01T10:00:00Z", "2026-09-01T10:10:00Z");
  await q(
    "INSERT INTO task_checkpoints(user_id,task_id,resume_note) VALUES($1,$2,'n')",
    [u.id, parent.id],
  );
  await q("INSERT INTO checkins(user_id,focus) VALUES($1,3)", [u.id]);
  const {
    rows: [d],
  } = await q(
    "INSERT INTO devices(user_id,label,token_hash) VALUES($1,'Chrome',$2) RETURNING *",
    [u.id, randomUUID()],
  );
  await q("INSERT INTO consent_events(user_id,device_id,granted,epoch) VALUES($1,$2,true,1)", [u.id, d.id]);
  await q("INSERT INTO user_preferences(user_id) VALUES($1)", [u.id]);
  await q(
    "INSERT INTO auth_sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,'c',now()+interval '1 day')",
    [u.id, randomUUID()],
  );
  await q(
    "INSERT INTO auth_events(user_id,email,event_type) VALUES($1,$2,'login_success')",
    [u.id, u.email],
  );
}
async function countRows(u) {
  const out = {};
  for (const table of [...ERASURE_ORDER, "auth_events"]) {
    const {
      rows: [r],
    } = await q(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [u.id]);
    out[table] = r.n;
  }
  return out;
}

test("ERASURE_ORDER covers every table that has a user_id column", async () => {
  const { rows } = await q(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
     JOIN information_schema.tables t USING(table_schema,table_name)
     WHERE c.table_schema='public' AND c.column_name='user_id' AND t.table_type='BASE TABLE'`,
  );
  const owned = rows.map((r) => r.table_name).sort();
  assert.deepEqual(owned, [...ERASURE_ORDER, "auth_events"].sort());
});

test("account erasure removes one user's complete graph and nothing else", async () => {
  const a = await makeUser();
  const b = await makeUser();
  await populate(a);
  await populate(b);
  const before = await countRows(a);
  for (const table of ["tasks", "plan_tasks", "work_segments", "task_events"])
    assert.ok(before[table] > 0, `${table} should be populated`);
  const keep = await countRows(b);

  const deleted = await db.transaction(async (tx) => {
    const wrapped = {
      query: async (sql, params) => {
        const r = await tx.query(sql, params);
        return { ...r, rowCount: r.affectedRows };
      },
    };
    return eraseAccount(wrapped, a);
  });

  assert.equal(deleted.users, 1);
  assert.equal(deleted.tasks, before.tasks);
  const after = await countRows(a);
  for (const [table, n] of Object.entries(after)) assert.equal(n, 0, table);
  const {
    rows: [gone],
  } = await q("SELECT count(*)::int n FROM users WHERE id=$1", [a.id]);
  assert.equal(gone.n, 0);
  assert.deepEqual(await countRows(b), keep);
  const {
    rows: [still],
  } = await q("SELECT count(*)::int n FROM users WHERE id=$1", [b.id]);
  assert.equal(still.n, 1);
});

test("erasure leaves the append-only guard active for later transactions", async () => {
  const u = await makeUser();
  const t = await makeTask(u);
  const {
    rows: [e],
  } = await q(
    "INSERT INTO task_events(user_id,task_id,event_type,new_status) VALUES($1,$2,'created','planned') RETURNING *",
    [u.id, t.id],
  );
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL steady.allow_erasure='on'");
  });
  await rejects(q("DELETE FROM task_events WHERE id=$1", [e.id]), /append-only/);
});
