/**
 * Cross-store erasure failure-injection test against the Docker Compose stack:
 *   1. Registers a user, pairs a Chrome device token, enables consent, and ingests events
 *   2. Stops the MongoDB 8 container while the app + PostgreSQL 17 remain running
 *   3. Calls DELETE /api/account and verifies it fails without leaving partial PG erasure
 *   4. Starts MongoDB 8 again, waits until healthy, retries DELETE /api/account -> 200
 *   5. Verifies directly against MongoDB that zero activity_events / task_event_mirror remain
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const base = process.env.TEST_URL || "http://localhost:3000/api";
const mongoUrl = process.env.MONGO_URL;
if (!mongoUrl) {
  throw new Error("MONGO_URL must be set for failure-injection.mjs");
}

function makeClient() {
  let cookie = "";
  let csrf = "";
  return async (urlPath, method = "GET", body, extra = {}) => {
    const r = await fetch(base + urlPath, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (r.headers.get("set-cookie")) {
      cookie = r.headers.get("set-cookie").split(";")[0];
    }
    if (json && json.csrf) csrf = json.csrf;
    return { status: r.status, body: json };
  };
}

function dc(cmd) {
  return execSync(`docker compose -f compose.yaml -f compose.test.yaml ${cmd}`, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForMongoHealthy(client) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const m = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 2000 });
      await m.connect();
      await m.db("steady").admin().ping();
      await m.close();
      const me = await client("/me");
      if (me.status === 200) return;
    } catch {
      // retry until Mongo recovers
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("MongoDB did not become reachable within 90s");
}

const c = makeClient();
const email = `fail-${randomUUID()}@example.test`;
const password = "amber-harbor-willow-99";
const reg = await c("/auth/register", "POST", {
  email,
  password,
  displayName: "Failure Injection",
  timezone: "UTC",
});
assert.equal(reg.status, 201, JSON.stringify(reg));
const userId = reg.body.user.id;

const task = await c("/tasks", "POST", { title: "Survive outage" });
assert.equal(task.status, 201);

const dev = await c("/devices", "POST", { label: "Fault Ext" });
assert.equal(dev.status, 201);
const headers = { Authorization: `Bearer ${dev.body.token}` };
const consent = await c("/extension/consent", "POST", { enabled: true }, headers);
assert.equal(consent.status, 200);

const now = Date.now() - 1000;
const ingest = await c(
  "/extension/events",
  "POST",
  {
    epoch: consent.body.epoch,
    events: [
      {
        eventId: randomUUID(),
        type: "interval",
        at: new Date(now).toISOString(),
        start: new Date(now - 10000).toISOString(),
        end: new Date(now).toISOString(),
        state: "active",
        domain: "example.org",
        category: "study",
      },
    ],
  },
  headers,
);
assert.equal(ingest.status, 200);

// Inject MongoDB outage
dc("stop mongo");

const delDuringOutage = await c("/account", "DELETE", {
  password,
  confirmation: "DELETE",
});
assert.notEqual(delDuringOutage.status, 200, "Erasure must fail cleanly during Mongo outage");

// Account must remain intact in PostgreSQL because the transaction rolled back
const meAfterRollback = await c("/me");
assert.equal(meAfterRollback.status, 200, "PostgreSQL account must remain intact after rollback");

// Recover MongoDB and retry erasure
dc("start mongo");
await waitForMongoHealthy(c);

const delAfterRecovery = await c("/account", "DELETE", {
  password,
  confirmation: "DELETE",
});
assert.equal(delAfterRecovery.status, 200, JSON.stringify(delAfterRecovery));

const meAfterRetry = await c("/me");
assert.equal(meAfterRetry.status, 401);

// Verify zero leftover MongoDB documents for the erased userId
const verifyClient = new MongoClient(mongoUrl);
await verifyClient.connect();
try {
  const sdb = verifyClient.db("steady");
  const actCount = await sdb.collection("activity_events").countDocuments({ userId });
  const mirCount = await sdb.collection("task_event_mirror").countDocuments({ userId });
  assert.equal(actCount, 0);
  assert.equal(mirCount, 0);

  console.log(
    `FAILURE_INJECTION_EVIDENCE ${JSON.stringify({
      generatedAt: new Date().toISOString(),
      deleteDuringOutageStatus: delDuringOutage.status,
      accountIntactAfterRollback: meAfterRollback.status === 200,
      deleteAfterRecoveryStatus: delAfterRecovery.status,
      postRecoveryAuthStatus: meAfterRetry.status,
      mongoActivityEventsRemaining: actCount,
      mongoMirrorDocsRemaining: mirCount,
    })}`,
  );
} finally {
  await verifyClient.close();
}
