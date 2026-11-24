/**
 * Controlled baseline comparison between a naive mutable CRUD schema (application
 * check-then-insert, scalar FKs, naive SUM aggregation, no consent epochs) and
 * Steady's database-enforced schema + interval-union aggregation on PGlite PG17.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { loadMigrations } from "../src/migrations.js";
import { unionSeconds } from "../src/metrics.js";

let naiveDb;
let steadyDb;
const matrix = [];

before(async () => {
  naiveDb = new PGlite();
  await naiveDb.exec(`
    CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE);
    CREATE TABLE tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, status text NOT NULL DEFAULT 'planned', estimated_minutes integer);
    CREATE TABLE sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), task_id uuid NOT NULL REFERENCES tasks(id), status text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
    CREATE TABLE segments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL REFERENCES sessions(id), started_at timestamptz NOT NULL, ended_at timestamptz);
    CREATE TABLE plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), plan_date date NOT NULL, revision integer NOT NULL DEFAULT 1, frozen_at timestamptz);
    CREATE TABLE plan_items(plan_id uuid NOT NULL REFERENCES plans(id), task_id uuid NOT NULL REFERENCES tasks(id), position integer NOT NULL, planned_minutes integer, PRIMARY KEY(plan_id, task_id));
    CREATE TABLE task_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), task_id uuid NOT NULL REFERENCES tasks(id), event_type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), label text NOT NULL, tracking_enabled boolean NOT NULL DEFAULT false);
    CREATE TABLE activity(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), start_ts timestamptz NOT NULL, end_ts timestamptz NOT NULL);
  `);

  steadyDb = new PGlite({ extensions: { btree_gist } });
  for (const m of await loadMigrations()) {
    await steadyDb.exec(m.sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    if (!m.baseline) {
      await steadyDb.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        m.version,
      ]);
    }
  }
});

after(async () => {
  console.log(`BASELINE_MATRIX ${JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: matrix })}`);
  await naiveDb.close();
  await steadyDb.close();
});

test("1. Check-then-insert concurrent focus session race", async () => {
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n1@test') RETURNING id");
  const { rows: [nt] } = await naiveDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T1') RETURNING id", [nu.id]);
  const [c1, c2] = await Promise.all([
    naiveDb.query("SELECT COUNT(*)::int AS c FROM sessions WHERE user_id=$1 AND status!='finished'", [nu.id]),
    naiveDb.query("SELECT COUNT(*)::int AS c FROM sessions WHERE user_id=$1 AND status!='finished'", [nu.id]),
  ]);
  assert.equal(c1.rows[0].c, 0);
  assert.equal(c2.rows[0].c, 0);
  await naiveDb.query("INSERT INTO sessions(user_id,task_id,status) VALUES($1,$2,'active')", [nu.id, nt.id]);
  await naiveDb.query("INSERT INTO sessions(user_id,task_id,status) VALUES($1,$2,'active')", [nu.id, nt.id]);
  const { rows: [nAfter] } = await naiveDb.query("SELECT COUNT(*)::int AS c FROM sessions WHERE user_id=$1 AND status!='finished'", [nu.id]);
  assert.equal(nAfter.c, 2);

  const { rows: [su] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s1@example.test','x','S1','UTC') RETURNING id");
  const { rows: [st] } = await steadyDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T1') RETURNING id", [su.id]);
  await steadyDb.query("INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key) VALUES($1,$2,1500,'active',$3)", [su.id, st.id, randomUUID()]);
  await assert.rejects(
    steadyDb.query("INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key) VALUES($1,$2,1500,'active',$3)", [su.id, st.id, randomUUID()]),
    /one_unfinished_session|unique/,
  );

  matrix.push({
    id: "concurrent_focus_race",
    scenario: "Check-then-insert two unfinished sessions",
    naive: "Admitted (2 active sessions)",
    steady: "Rejected (partial unique index one_unfinished_session)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});

test("2. Overlapping work segments within a single account", async () => {
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n2@test') RETURNING id");
  const { rows: [nt] } = await naiveDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T2') RETURNING id", [nu.id]);
  const { rows: [ns] } = await naiveDb.query("INSERT INTO sessions(user_id,task_id,status) VALUES($1,$2,'finished') RETURNING id", [nu.id, nt.id]);
  await naiveDb.query("INSERT INTO segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,'2026-10-29T10:00:00Z','2026-10-29T10:20:00Z')", [nu.id, ns.id]);
  await naiveDb.query("INSERT INTO segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,'2026-10-29T10:10:00Z','2026-10-29T10:30:00Z')", [nu.id, ns.id]);
  const { rows: [nc] } = await naiveDb.query("SELECT COUNT(*)::int AS c FROM segments WHERE user_id=$1", [nu.id]);
  assert.equal(nc.c, 2);

  const { rows: [su] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s2@example.test','x','S2','UTC') RETURNING id");
  const { rows: [st] } = await steadyDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T2') RETURNING id", [su.id]);
  const { rows: [ss] } = await steadyDb.query("INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key,started_at,ended_at) VALUES($1,$2,1500,'finished',$3,'2026-10-29T09:50:00Z','2026-10-29T11:00:00Z') RETURNING id", [su.id, st.id, randomUUID()]);
  await steadyDb.query("INSERT INTO work_segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,'2026-10-29T10:00:00Z','2026-10-29T10:20:00Z')", [su.id, ss.id]);
  await assert.rejects(
    steadyDb.query("INSERT INTO work_segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,'2026-10-29T10:10:00Z','2026-10-29T10:30:00Z')", [su.id, ss.id]),
    /work_segments_no_overlap|exclusion/,
  );

  matrix.push({
    id: "overlapping_segments",
    scenario: "Overlapping work segments for one user",
    naive: "Admitted (overlapping intervals stored)",
    steady: "Rejected (btree_gist EXCLUDE constraint)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});

test("3. Mutating a frozen daily plan membership", async () => {
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n3@test') RETURNING id");
  const { rows: [nt] } = await naiveDb.query("INSERT INTO tasks(user_id,title,estimated_minutes) VALUES($1,'T3',20) RETURNING id", [nu.id]);
  const { rows: [np] } = await naiveDb.query("INSERT INTO plans(user_id,plan_date,revision,frozen_at) VALUES($1,'2026-10-29',1,now()) RETURNING id", [nu.id]);
  await naiveDb.query("INSERT INTO plan_items(plan_id,task_id,position,planned_minutes) VALUES($1,$2,0,20)", [np.id, nt.id]);
  const upd = await naiveDb.query("UPDATE plan_items SET planned_minutes=90 WHERE plan_id=$1 AND task_id=$2", [np.id, nt.id]);
  assert.equal(upd.rowCount, 1);

  const { rows: [su] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s3@example.test','x','S3','UTC') RETURNING id");
  const { rows: [st] } = await steadyDb.query("INSERT INTO tasks(user_id,title,estimated_minutes) VALUES($1,'T3',20) RETURNING id", [su.id]);
  const { rows: [sp] } = await steadyDb.query("INSERT INTO daily_plans(user_id,plan_date,timezone,revision) VALUES($1,'2026-10-29','UTC',1) RETURNING id", [su.id]);
  await steadyDb.query("INSERT INTO plan_tasks(user_id,plan_id,task_id,position,planned_minutes) VALUES($1,$2,$3,0,20)", [su.id, sp.id, st.id]);
  await steadyDb.query("UPDATE daily_plans SET frozen_at=now() WHERE id=$1", [sp.id]);
  await assert.rejects(
    steadyDb.query("UPDATE plan_tasks SET planned_minutes=90 WHERE plan_id=$1 AND task_id=$2", [sp.id, st.id]),
    /frozen/i,
  );

  matrix.push({
    id: "frozen_plan_mutation",
    scenario: "Editing frozen daily plan / membership",
    naive: "Admitted (denominator overwritten in place)",
    steady: "Rejected (frozen_plan / frozen_members triggers)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});

test("4. Cross-tenant task reference across accounts", async () => {
  const { rows: [na] } = await naiveDb.query("INSERT INTO users(email) VALUES('n4a@test') RETURNING id");
  const { rows: [nb] } = await naiveDb.query("INSERT INTO users(email) VALUES('n4b@test') RETURNING id");
  const { rows: [nat] } = await naiveDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'A-secret') RETURNING id", [na.id]);
  const nCross = await naiveDb.query("INSERT INTO sessions(user_id,task_id,status) VALUES($1,$2,'active') RETURNING id", [nb.id, nat.id]);
  assert.equal(nCross.rows.length, 1);

  const { rows: [sa] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s4a@example.test','x','SA','UTC') RETURNING id");
  const { rows: [sb] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s4b@example.test','x','SB','UTC') RETURNING id");
  const { rows: [sat] } = await steadyDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'A-secret') RETURNING id", [sa.id]);
  await assert.rejects(
    steadyDb.query("INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key) VALUES($1,$2,1500,'active',$3)", [sb.id, sat.id, randomUUID()]),
    /foreign key|violates foreign key/,
  );

  matrix.push({
    id: "cross_tenant_fk",
    scenario: "Cross-tenant session referencing another user's task",
    naive: "Admitted (scalar FK ignores owner mismatch)",
    steady: "Rejected (composite (user_id, id) FK)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});

test("5. Deleting audit history rows outside erasure", async () => {
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n5@test') RETURNING id");
  const { rows: [nt] } = await naiveDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T5') RETURNING id", [nu.id]);
  const { rows: [nh] } = await naiveDb.query("INSERT INTO task_history(user_id,task_id,event_type) VALUES($1,$2,'created') RETURNING id", [nu.id, nt.id]);
  const del = await naiveDb.query("DELETE FROM task_history WHERE id=$1", [nh.id]);
  assert.equal(del.rowCount, 1);

  const { rows: [su] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s5@example.test','x','S5','UTC') RETURNING id");
  const { rows: [st] } = await steadyDb.query("INSERT INTO tasks(user_id,title) VALUES($1,'T5') RETURNING id", [su.id]);
  const { rows: [sh] } = await steadyDb.query("INSERT INTO task_events(user_id,task_id,event_type) VALUES($1,$2,'created') RETURNING id", [su.id, st.id]);
  await assert.rejects(
    steadyDb.query("DELETE FROM task_events WHERE id=$1", [sh.id]),
    /append-only/,
  );

  matrix.push({
    id: "audit_history_delete",
    scenario: "Deleting historical task_events audit row",
    naive: "Admitted (audit trail silently deleted)",
    steady: "Rejected (append_only_history BEFORE trigger)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});

test("6. Retry inflation: 10 identical 10-second intervals", async () => {
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n6@test') RETURNING id");
  const t0 = Date.parse("2026-10-29T12:00:00Z");
  const intervals = [];
  for (let i = 0; i < 10; i++) {
    await naiveDb.query("INSERT INTO activity(user_id,start_ts,end_ts) VALUES($1,$2,$3)", [
      nu.id,
      new Date(t0).toISOString(),
      new Date(t0 + 10000).toISOString(),
    ]);
    intervals.push([t0, t0 + 10000]);
  }
  const { rows: [nSum] } = await naiveDb.query("SELECT SUM(EXTRACT(EPOCH FROM (end_ts - start_ts)))::int AS s FROM activity WHERE user_id=$1", [nu.id]);
  assert.equal(nSum.s, 100);

  const sUnion = unionSeconds(intervals);
  assert.equal(sUnion, 10);

  matrix.push({
    id: "retry_inflation",
    scenario: "10 duplicate retries of a 10 s interval",
    naive: "Admitted (SUM = 100 s; +900% overcount)",
    steady: "Bounded (unionSeconds = 10 s)",
    naiveAdmitted: true,
    steadyAdmitted: false,
    naiveSeconds: nSum.s,
    steadySeconds: sUnion,
  });
});

test("7. Stale-epoch buffered upload after revocation & re-enable", async () => {
  // Sequence: device enabled -> event buffered at old state -> user revokes/purges -> user re-enables.
  // Without an epoch version counter, checking only tracking_enabled admits the stale buffered event.
  const { rows: [nu] } = await naiveDb.query("INSERT INTO users(email) VALUES('n7@test') RETURNING id");
  const { rows: [nd] } = await naiveDb.query("INSERT INTO devices(user_id,label,tracking_enabled) VALUES($1,'Ext',true) RETURNING id", [nu.id]);
  await naiveDb.query("UPDATE devices SET tracking_enabled=false WHERE id=$1", [nd.id]);
  await naiveDb.query("UPDATE devices SET tracking_enabled=true WHERE id=$1", [nd.id]);
  const nGate = await naiveDb.query("SELECT id FROM devices WHERE id=$1 AND tracking_enabled=true", [nd.id]);
  assert.equal(nGate.rowCount, 1);

  const { rows: [su] } = await steadyDb.query("INSERT INTO users(email,password_hash,display_name,timezone) VALUES('s7@example.test','x','S7','UTC') RETURNING id");
  const { rows: [sd] } = await steadyDb.query("INSERT INTO devices(user_id,label,token_hash,tracking_enabled,consent_epoch) VALUES($1,'Ext','tok7',true,1) RETURNING id", [su.id]);
  const bufferedEpoch = 1;
  await steadyDb.query("UPDATE devices SET tracking_enabled=false,consent_epoch=consent_epoch+1 WHERE id=$1", [sd.id]);
  await steadyDb.query("UPDATE devices SET tracking_enabled=true,consent_epoch=consent_epoch+1 WHERE id=$1", [sd.id]);
  const sGate = await steadyDb.query("SELECT id FROM devices WHERE id=$1 AND tracking_enabled=true AND consent_epoch=$2", [sd.id, bufferedEpoch]);
  assert.equal(sGate.rowCount, 0);

  matrix.push({
    id: "stale_consent_epoch",
    scenario: "Pre-revocation buffered batch after revoke & re-enable",
    naive: "Admitted (tracking_enabled=true matches without epoch)",
    steady: "Rejected (consent_epoch 3 != buffered epoch 1)",
    naiveAdmitted: true,
    steadyAdmitted: false,
  });
});
