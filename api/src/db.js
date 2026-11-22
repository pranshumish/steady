import pg from "pg";
import { MongoClient } from "mongodb";
import { loadMigrations } from "./migrations.js";
import { activityEventValidator } from "./mongo-schema.js";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
});
export const client = new MongoClient(process.env.MONGO_URL, {
  serverSelectionTimeoutMS: 5000,
});
export let events;
export let journal;

/** Apply SQL migrations under a global advisory lock, then prepare MongoDB. */
export async function initialize() {
  const migrations = await loadMigrations();
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await conn.query("SELECT pg_advisory_xact_lock(7240031)");
    for (const m of migrations) {
      if (m.baseline) {
        await conn.query(m.sql); // idempotent baseline
        continue;
      }
      const { rowCount } = await conn.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [m.version],
      );
      if (rowCount) continue;
      await conn.query(m.sql);
      await conn.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        m.version,
      ]);
    }
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }

  await client.connect();
  const db = client.db("steady");
  const exists = await db
    .listCollections({ name: "activity_events" })
    .hasNext();
  if (!exists)
    await db.createCollection("activity_events", {
      validator: activityEventValidator,
      validationLevel: "moderate",
      validationAction: "error",
    });
  else
    await db.command({
      collMod: "activity_events",
      validator: activityEventValidator,
      validationLevel: "moderate",
      validationAction: "error",
    });
  events = db.collection("activity_events");
  journal = db.collection("task_event_mirror");
  await events.createIndex(
    { userId: 1, deviceId: 1, eventId: 1 },
    { unique: true },
  );
  await events.createIndex({ userId: 1, at: 1 });
  await events.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await journal.createIndex({ outboxId: 1 }, { unique: true });
  await journal.createIndex({ userId: 1 });
  await journal.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

/** Run fn inside a transaction serialized per user by an advisory lock. */
export async function transaction(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      userId,
    ]);
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** Append a task event and its outbox record in the caller's transaction. */
export async function taskEvent(c, userId, taskId, type, oldStatus, newStatus) {
  const {
    rows: [e],
  } = await c.query(
    "INSERT INTO task_events(user_id,task_id,event_type,old_status,new_status) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [userId, taskId, type, oldStatus ?? null, newStatus ?? null],
  );
  await c.query(
    "INSERT INTO outbox_events(user_id,task_event_id,event_type,payload) VALUES($1,$2,$3,$4)",
    [
      userId,
      e.id,
      type,
      { taskId, eventId: e.id, occurredAt: e.occurred_at },
    ],
  );
}

let running = false;
/** Deliver pending outbox rows to the MongoDB mirror (at-least-once, idempotent). */
export async function processOutbox() {
  if (running) return;
  running = true;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      "SELECT * FROM outbox_events WHERE processed_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
    );
    for (const e of rows) {
      await journal.updateOne(
        { outboxId: e.id },
        {
          $setOnInsert: {
            outboxId: e.id,
            userId: e.user_id,
            type: e.event_type,
            payload: e.payload,
            expiresAt: new Date(Date.now() + 30 * 86400000),
          },
        },
        { upsert: true },
      );
      await c.query(
        "UPDATE outbox_events SET processed_at=now(),attempts=attempts+1 WHERE id=$1",
        [e.id],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("Outbox delivery deferred:", e.code || e.name);
  } finally {
    c.release();
    running = false;
  }
}
