/**
 * Real-engine database tests executed directly against Dockerized PostgreSQL 17
 * and MongoDB 8 (when DATABASE_URL and MONGO_URL are provided):
 *   1. True multi-connection PostgreSQL races (pg.Pool max=50) without advisory locks
 *   2. Real MongoDB 8 $jsonSchema validator, unique index, and TTL monitor expiry
 *   3. PostgreSQL JSONB vs. MongoDB 8 telemetry ingest throughput & query latency
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { MongoClient } from "mongodb";
import { activityEventValidator } from "../src/mongo-schema.js";
import { buildActivityDoc } from "../src/ingest.js";
import { dayWindow } from "../src/metrics.js";

const hasRealEnv = Boolean(process.env.DATABASE_URL && process.env.MONGO_URL);
let pool;
let mongoClient;
let db;
const evidence = {
  generatedAt: new Date().toISOString(),
  pgRaces: [],
  mongoValidationAndTtl: null,
  storeComparison: null,
};

function round2(v) {
  return Math.round(v * 100) / 100;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    r: n,
    meanMs: round2(mean),
    sdMs: round2(Math.sqrt(variance)),
    p50Ms: round2(s[Math.min(n - 1, Math.floor(0.5 * n))]),
    p95Ms: round2(s[Math.min(n - 1, Math.floor(0.95 * n))]),
  };
}

async function cleanupPgUsers(userIds) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('steady.allow_erasure','on',true)");
    for (const table of [
      "outbox_events",
      "work_segments",
      "focus_sessions",
      "task_events",
      "tasks",
      "users",
    ]) {
      const col = table === "users" ? "id" : "user_id";
      await c.query(`DELETE FROM ${table} WHERE ${col} = ANY($1::uuid[])`, [
        userIds,
      ]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

before(async () => {
  if (!hasRealEnv) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 50 });
  mongoClient = new MongoClient(process.env.MONGO_URL);
  await mongoClient.connect();
  db = mongoClient.db("steady");
});

after(async () => {
  if (!hasRealEnv) return;
  console.log(`REAL_ENGINE_EVIDENCE ${JSON.stringify(evidence)}`);
  await mongoClient?.close();
  await pool?.end();
});

test(
  "Real PostgreSQL 17 multi-connection constraint races (pool max=50, no advisory lock)",
  { skip: !hasRealEnv },
  async () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    try {
      // Seed users and tasks
      for (const uid of [u1, u2, u3]) {
        await pool.query(
          "INSERT INTO users(id,email,password_hash,display_name,timezone) VALUES($1,$2,'x','Race User','UTC')",
          [uid, `race-${uid}@example.test`],
        );
      }
      const {
        rows: [t1],
      } = await pool.query(
        "INSERT INTO tasks(user_id,title) VALUES($1,'Race T1') RETURNING id",
        [u1],
      );
      const {
        rows: [t2],
      } = await pool.query(
        "INSERT INTO tasks(user_id,title) VALUES($1,'Race T2') RETURNING id",
        [u2],
      );
      const {
        rows: [t3],
      } = await pool.query(
        "INSERT INTO tasks(user_id,title) VALUES($1,'Race T3') RETURNING id",
        [u3],
      );
      const {
        rows: [s3],
      } = await pool.query(
        "INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key,started_at,ended_at) VALUES($1,$2,1800,'finished',$3,'2026-10-29T09:50:00Z','2026-10-29T11:00:00Z') RETURNING id",
        [u3, t3.id, randomUUID()],
      );

      // Race 1a: 200 distinct concurrent INSERTs into focus_sessions (partial unique index one_unfinished_session)
      const raceA = await Promise.all(
        Array.from({ length: 200 }, async () => {
          const t0 = performance.now();
          try {
            await pool.query(
              "INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key) VALUES($1,$2,1500,'active',$3)",
              [u1, t1.id, randomUUID()],
            );
            return { ok: true, code: null, ms: performance.now() - t0 };
          } catch (err) {
            return { ok: false, code: err.code, ms: performance.now() - t0 };
          }
        }),
      );
      const okA = raceA.filter((r) => r.ok);
      const rejA = raceA.filter((r) => !r.ok);
      assert.equal(okA.length, 1);
      assert.equal(rejA.length, 199);
      assert.ok(rejA.every((r) => r.code === "23505"));
      evidence.pgRaces.push({
        race: "200 concurrent active sessions (distinct keys)",
        attempts: 200,
        succeeded: okA.length,
        rejected: rejA.length,
        sqlstate: "23505 (one_unfinished_session)",
        ...stats(raceA.map((r) => r.ms)),
      });

      // Race 1b: 50 duplicate idempotency-key INSERTs into focus_sessions
      const sharedKey = randomUUID();
      const raceB = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const t0 = performance.now();
          try {
            await pool.query(
              "INSERT INTO focus_sessions(user_id,task_id,planned_seconds,status,start_request_key) VALUES($1,$2,1500,'active',$3)",
              [u2, t2.id, sharedKey],
            );
            return { ok: true, code: null, ms: performance.now() - t0 };
          } catch (err) {
            return { ok: false, code: err.code, ms: performance.now() - t0 };
          }
        }),
      );
      const okB = raceB.filter((r) => r.ok);
      const rejB = raceB.filter((r) => !r.ok);
      assert.equal(okB.length, 1);
      assert.equal(rejB.length, 49);
      assert.ok(rejB.every((r) => r.code === "23505"));
      evidence.pgRaces.push({
        race: "50 concurrent identical start_request_key inserts",
        attempts: 50,
        succeeded: okB.length,
        rejected: rejB.length,
        sqlstate: "23505",
        ...stats(raceB.map((r) => r.ms)),
      });

      // Race 1c: 100 concurrent closed overlapping work_segments (GiST EXCLUDE constraint, 23P01)
      const raceC = await Promise.all(
        Array.from({ length: 100 }, async () => {
          const t0 = performance.now();
          try {
            await pool.query(
              "INSERT INTO work_segments(user_id,session_id,started_at,ended_at) VALUES($1,$2,'2026-10-29T10:00:00Z','2026-10-29T10:30:00Z')",
              [u3, s3.id],
            );
            return { ok: true, code: null, ms: performance.now() - t0 };
          } catch (err) {
            return { ok: false, code: err.code, ms: performance.now() - t0 };
          }
        }),
      );
      const okC = raceC.filter((r) => r.ok);
      const rejC = raceC.filter((r) => !r.ok);
      assert.equal(okC.length, 1);
      assert.equal(rejC.length, 99);
      assert.ok(rejC.every((r) => r.code === "23P01"));
      evidence.pgRaces.push({
        race: "100 concurrent overlapping work_segments",
        attempts: 100,
        succeeded: okC.length,
        rejected: rejC.length,
        sqlstate: "23P01 (work_segments_no_overlap)",
        ...stats(raceC.map((r) => r.ms)),
      });
    } finally {
      await cleanupPgUsers([u1, u2, u3]);
    }
  },
);

test(
  "Real MongoDB 8 $jsonSchema validator, unique key, and TTL expiry",
  { skip: !hasRealEnv },
  async () => {
    const colName = `rt_activity_val_${randomUUID().slice(0, 8)}`;
    await db.createCollection(colName, {
      validator: activityEventValidator,
      validationLevel: "moderate",
      validationAction: "error",
    });
    const col = db.collection(colName);
    try {
      await col.createIndex({ userId: 1, deviceId: 1, eventId: 1 }, { unique: true });
      await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

      const dev = { id: randomUUID(), user_id: randomUUID() };
      const now = Date.now();
      const validEvt = {
        eventId: randomUUID(),
        type: "interval",
        at: new Date(now).toISOString(),
        start: new Date(now - 10000).toISOString(),
        end: new Date(now).toISOString(),
        state: "active",
        domain: "example.org",
        category: "study",
      };
      const { doc: validDoc } = buildActivityDoc(validEvt, dev, 1);
      await col.insertOne(validDoc);

      // Duplicate key rejected (11000)
      await assert.rejects(col.insertOne({ ...validDoc }), (e) => e.code === 11000);

      // Invalid document shapes rejected by real MongoDB 8 validator (code 121)
      const { start: _omit, ...missingStart } = validDoc;
      const { doc: tabDoc } = buildActivityDoc(
        { eventId: randomUUID(), type: "tab_switch", at: new Date(now).toISOString() },
        dev,
        1,
      );
      const invalidCases = [
        { name: "unknown_field", doc: { ...validDoc, eventId: randomUUID(), extra: 1 } },
        { name: "missing_interval_start", doc: { ...missingStart, eventId: randomUUID() } },
        { name: "tab_switch_with_domain", doc: { ...tabDoc, domain: "example.org" } },
        { name: "invalid_state_enum", doc: { ...validDoc, eventId: randomUUID(), state: "paused" } },
      ];
      for (const tc of invalidCases) {
        await assert.rejects(
          col.insertOne(tc.doc),
          (e) => e.code === 121,
          `Expected code 121 for ${tc.name}`,
        );
      }

      // Real MongoDB 8 TTL background monitor verification (expiresAt 1s in past)
      const ttlEvtId = randomUUID();
      const { doc: ttlBase } = buildActivityDoc(
        { ...validEvt, eventId: ttlEvtId },
        dev,
        1,
      );
      ttlBase.expiresAt = new Date(Date.now() - 1000);
      await col.insertOne(ttlBase);
      const tStart = performance.now();
      let deleted = false;
      while (performance.now() - tStart < 120000) {
        const found = await col.findOne({ eventId: ttlEvtId });
        if (!found) {
          deleted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      const ttlObservedSeconds = round2((performance.now() - tStart) / 1000);
      assert.ok(deleted, "MongoDB TTL monitor did not expire past-due doc within 120s");

      evidence.mongoValidationAndTtl = {
        validAccepted: true,
        duplicateKeyRejectedCode: 11000,
        invalidShapesRejectedCode121: invalidCases.map((c) => c.name),
        ttlExpiredWithin120s: deleted,
        ttlObservedSeconds,
      };
    } finally {
      await col.drop().catch(() => {});
    }
  },
);

test(
  "Telemetry store comparison: PostgreSQL JSONB vs. MongoDB 8 (10,000 events)",
  { skip: !hasRealEnv },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const pgTable = `rt_activity_cmp_${suffix}`;
    const mongoColName = `rt_activity_cmp_${suffix}`;
    const userId = randomUUID();
    const device = { id: randomUUID(), user_id: userId };
    const { start, end } = dayWindow("2026-10-29", "UTC");

    const docs = [];
    for (let i = 0; i < 10000; i++) {
      const s = start + ((i * 7919) % 80000000);
      const e = s + 10000;
      const evt = {
        eventId: randomUUID(),
        type: "interval",
        at: new Date(e).toISOString(),
        start: new Date(s).toISOString(),
        end: new Date(e).toISOString(),
        state: "active",
        domain: "scholar.google.com",
        category: "study",
      };
      docs.push(buildActivityDoc(evt, device, 1).doc);
    }

    await pool.query(`
      CREATE TABLE ${pgTable} (
        user_id uuid NOT NULL,
        device_id uuid NOT NULL,
        event_id uuid NOT NULL,
        doc jsonb NOT NULL CHECK (
          doc ? 'type'
          AND (doc->>'type') IN ('interval', 'tab_switch')
          AND jsonb_typeof(doc->'at') = 'string'
        ),
        at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        UNIQUE (user_id, device_id, event_id)
      );
      CREATE INDEX ${pgTable}_user_at_idx ON ${pgTable} (user_id, at);
    `);

    await db.createCollection(mongoColName, {
      validator: activityEventValidator,
      validationLevel: "moderate",
      validationAction: "error",
    });
    const mCol = db.collection(mongoColName);
    await mCol.createIndex({ userId: 1, deviceId: 1, eventId: 1 }, { unique: true });
    await mCol.createIndex({ userId: 1, at: 1 });

    try {
      // PG batch ingest (50 batches x 200 events via unnest)
      const pgIngestStart = performance.now();
      for (let i = 0; i < docs.length; i += 200) {
        const batch = docs.slice(i, i + 200);
        await pool.query(
          `INSERT INTO ${pgTable}(user_id, device_id, event_id, doc, at, expires_at)
           SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::jsonb[], $5::timestamptz[], $6::timestamptz[])
           ON CONFLICT (user_id, device_id, event_id) DO NOTHING`,
          [
            batch.map((d) => d.userId),
            batch.map((d) => d.deviceId),
            batch.map((d) => d.eventId),
            batch.map((d) => JSON.stringify({ type: d.type, at: d.at.toISOString(), state: d.state, domain: d.domain, category: d.category })),
            batch.map((d) => d.at),
            batch.map((d) => d.expiresAt),
          ],
        );
      }
      const pgIngestMs = performance.now() - pgIngestStart;

      // MongoDB batch ingest (50 batches x 200 bulkWrite $setOnInsert upserts)
      const mIngestStart = performance.now();
      for (let i = 0; i < docs.length; i += 200) {
        const batch = docs.slice(i, i + 200);
        await mCol.bulkWrite(
          batch.map((d) => ({
            updateOne: {
              filter: { userId: d.userId, deviceId: d.deviceId, eventId: d.eventId },
              update: { $setOnInsert: d },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }
      const mIngestMs = performance.now() - mIngestStart;

      // Range query comparison: 5 warm-up + 30 measured
      const qStart = new Date(start);
      const qEnd = new Date(end + 61000);
      for (let i = 0; i < 5; i++) {
        await pool.query(
          `SELECT doc FROM ${pgTable} WHERE user_id=$1 AND expires_at > now() AND at >= $2 AND at < $3 LIMIT 100001`,
          [userId, qStart, qEnd],
        );
        await mCol
          .find({ userId, expiresAt: { $gt: new Date() }, at: { $gte: qStart, $lt: qEnd } })
          .limit(100001)
          .toArray();
      }

      const pgQueryTimes = [];
      const mQueryTimes = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        const pgRes = await pool.query(
          `SELECT doc FROM ${pgTable} WHERE user_id=$1 AND expires_at > now() AND at >= $2 AND at < $3 LIMIT 100001`,
          [userId, qStart, qEnd],
        );
        pgQueryTimes.push(performance.now() - t0);
        assert.equal(pgRes.rows.length, 10000);

        const t1 = performance.now();
        const mRes = await mCol
          .find({ userId, expiresAt: { $gt: new Date() }, at: { $gte: qStart, $lt: qEnd } })
          .limit(100001)
          .toArray();
        mQueryTimes.push(performance.now() - t1);
        assert.equal(mRes.length, 10000);
      }

      evidence.storeComparison = {
        eventCount: 10000,
        batchSize: 200,
        postgresJsonb: {
          ingestMs: round2(pgIngestMs),
          ingestEventsPerSec: Math.round((10000 / pgIngestMs) * 1000),
          query: stats(pgQueryTimes),
        },
        mongodb8: {
          ingestMs: round2(mIngestMs),
          ingestEventsPerSec: Math.round((10000 / mIngestMs) * 1000),
          query: stats(mQueryTimes),
        },
      };
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${pgTable}`).catch(() => {});
      await mCol.drop().catch(() => {});
    }
  },
);
