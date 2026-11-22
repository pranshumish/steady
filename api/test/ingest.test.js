import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { activityEventValidator } from "../src/mongo-schema.js";
import { buildActivityDoc } from "../src/ingest.js";
import { passwordIssues, LOCKOUT } from "../src/validation.js";

/**
 * Minimal evaluator for the $jsonSchema subset used by the validator
 * (bsonType, enum, pattern, minimum, maxLength, required, properties,
 * additionalProperties, oneOf, not, anyOf). It lets us check that documents the
 * real ingestion code produces are accepted, and malformed ones rejected,
 * without a running MongoDB. MongoDB itself remains the final authority.
 */
function bsonTypeOf(v) {
  if (v === null) return "null";
  if (v instanceof Date) return "date";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  return typeof v;
}
function matches(schema, v) {
  if (schema.bsonType) {
    const allowed = [].concat(schema.bsonType);
    if (!allowed.includes(bsonTypeOf(v)) && !(allowed.includes("object") && bsonTypeOf(v) === "object"))
      return false;
  }
  if (schema.enum && !schema.enum.includes(v)) return false;
  if (schema.pattern && !(typeof v === "string" && new RegExp(schema.pattern).test(v))) return false;
  if (schema.maxLength !== undefined && typeof v === "string" && v.length > schema.maxLength) return false;
  if (schema.minimum !== undefined && typeof v === "number" && v < schema.minimum) return false;
  if (schema.bsonType === "object" || schema.properties || schema.required) {
    if (v === null || typeof v !== "object") return false;
    for (const r of schema.required || []) if (!(r in v)) return false;
    for (const [k, val] of Object.entries(v)) {
      if (schema.properties && k in schema.properties) {
        if (!matches(schema.properties[k], val)) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => matches(s, v))) return false;
  if (schema.not && matches(schema.not, v)) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => matches(s, v)).length !== 1) return false;
  return true;
}
const valid = (doc) => matches(activityEventValidator.$jsonSchema, doc);

const device = { id: randomUUID(), user_id: randomUUID() };
const nowIso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const interval = () => ({
  eventId: randomUUID(),
  type: "interval",
  at: nowIso(),
  start: nowIso(-10000),
  end: nowIso(),
  state: "active",
  domain: "example.org",
  category: "study",
});

test("validator accepts documents produced by the ingestion code", () => {
  const idle = { ...interval(), state: "idle", domain: null };
  const tab = { eventId: randomUUID(), type: "tab_switch", at: nowIso() };
  for (const e of [interval(), idle, tab]) {
    const { doc } = buildActivityDoc(e, device, 3);
    assert.ok(valid(doc), JSON.stringify(doc));
  }
});

test("validator rejects shapes the API never produces", () => {
  const { doc } = buildActivityDoc(interval(), device, 1);
  assert.ok(valid(doc));
  assert.ok(!valid({ ...doc, extra: 1 }), "unknown field");
  assert.ok(!valid({ ...doc, category: "work" }), "unknown category");
  assert.ok(!valid({ ...doc, state: "paused" }), "unknown state");
  assert.ok(!valid({ ...doc, epoch: -1 }), "negative epoch");
  assert.ok(!valid({ ...doc, at: "2026-01-01" }), "date stored as string");
  assert.ok(!valid({ ...doc, digest: "short" }), "bad digest");
  assert.ok(!valid({ ...doc, userId: "not-a-uuid" }), "bad owner id");
  const { start, ...noStart } = doc;
  assert.ok(!valid(noStart), "interval missing start");
  const { doc: tab } = buildActivityDoc(
    { eventId: randomUUID(), type: "tab_switch", at: nowIso() },
    device,
    1,
  );
  assert.ok(valid(tab));
  assert.ok(!valid({ ...tab, domain: "example.org" }), "tab_switch must not carry a domain");
});

test("ingestion digest is stable and expiry is thirty days after the event", () => {
  const e = interval();
  const a = buildActivityDoc(e, device, 1);
  const b = buildActivityDoc(e, device, 1);
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, buildActivityDoc({ ...e, domain: "other.org" }, device, 1).digest);
  assert.equal(+a.doc.expiresAt - +new Date(e.at), 30 * 86400000);
  assert.deepEqual(a.filter, { userId: device.user_id, deviceId: device.id, eventId: e.eventId });
});

test("password policy rejects short, common, repeated and personal passwords", () => {
  const ctx = { email: "pranshu.mishra@example.com", displayName: "Pranshu Mishra" };
  assert.deepEqual(passwordIssues("a-very-unusual-passphrase-42", ctx), []);
  assert.ok(passwordIssues("short", ctx).some((m) => /at least 10/.test(m)));
  assert.ok(passwordIssues("Password123", ctx).some((m) => /common/.test(m)));
  assert.ok(passwordIssues("aaaaaaaaaaaa", ctx).some((m) => /repeating/.test(m)));
  assert.ok(passwordIssues("xx-pranshu.mishra-xx", ctx).some((m) => /email/.test(m)));
  assert.ok(passwordIssues("mishra-is-my-name", ctx).some((m) => /name/.test(m)));
  assert.ok(passwordIssues("x".repeat(129), ctx).some((m) => /128/.test(m)));
  assert.ok(LOCKOUT.maxFailures >= 3 && LOCKOUT.windowMinutes >= 5);
});
