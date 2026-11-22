import { readdir, readFile } from "node:fs/promises";

const dir = new URL("../../db/", import.meta.url);

/**
 * Discover ordered SQL migrations (NNN_name.sql) in /db.
 * 001_* is the idempotent baseline and is re-run safely at every start;
 * later files run exactly once and are recorded in schema_migrations.
 */
export async function loadMigrations() {
  const names = (await readdir(dir))
    .filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      version: name.replace(/\.sql$/, ""),
      baseline: name.startsWith("001_"),
      sql: await readFile(new URL(name, dir), "utf8"),
    })),
  );
}
