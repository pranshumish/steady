/**
 * Account erasure. Kept free of database-connection side effects so the exact
 * routine can be tested against a real PostgreSQL engine.
 */

/**
 * Tables holding per-user rows, ordered children-first so every foreign key is
 * satisfied. A test asserts this list covers every table with a user_id column,
 * so a future migration cannot silently add an unerasable table.
 */
export const ERASURE_ORDER = [
  "outbox_events",
  "plan_tasks",
  "work_segments",
  "focus_sessions",
  "task_checkpoints",
  "task_events",
  "daily_plans",
  "consent_events",
  "devices",
  "checkins",
  "tasks",
  "projects",
  "user_preferences",
  "auth_sessions",
];

/**
 * Permanently delete one account and everything it owns, inside the caller's
 * transaction. Append-only/immutable triggers allow DELETE only while the
 * transaction-local flag steady.allow_erasure is on, which is set here.
 * Returns per-table deleted row counts.
 */
export async function eraseAccount(c, user) {
  await c.query("SELECT set_config('steady.allow_erasure','on',true)");
  const deleted = {};
  for (const table of ERASURE_ORDER) {
    const r = await c.query(`DELETE FROM ${table} WHERE user_id=$1`, [user.id]);
    deleted[table] = r.rowCount;
  }
  const a = await c.query(
    "DELETE FROM auth_events WHERE user_id=$1 OR email=$2",
    [user.id, user.email],
  );
  deleted.auth_events = a.rowCount;
  const u = await c.query("DELETE FROM users WHERE id=$1", [user.id]);
  deleted.users = u.rowCount;
  return deleted;
}
