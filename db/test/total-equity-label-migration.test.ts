import assert from "node:assert/strict";
import test from "node:test";
import { dockerAvailable } from "./docker-pg.ts";
import { applyCanonicalSchema, applyMigration, createDatabase, startServer } from "./financial-migration-helpers.ts";

test("0062 names total_equity Stockholders' Equity in an existing registry", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for migration coverage");
    return;
  }
  const server = await startServer(t, "total-equity-0062");
  const db = await createDatabase(t, server, "total_equity_0062");
  await applyCanonicalSchema(db);
  await db.query(`
    insert into metrics (metric_id, metric_key, display_name, unit_class, aggregation, interpretation, canonical_source_class) values
      (gen_random_uuid(), 'total_equity', 'Total Equity', 'currency', 'point_in_time', 'higher_is_better', 'gaap'),
      (gen_random_uuid(), 'total_assets', 'Total Assets', 'currency', 'point_in_time', 'neutral', 'gaap')`);
  const names = async () => Object.fromEntries((await db.query(`select metric_key, display_name from metrics order by metric_key`)).rows.map((row) => [row.metric_key, row.display_name]));

  await applyMigration(db, "0062", "up");
  assert.deepEqual(await names(), { total_assets: "Total Assets", total_equity: "Stockholders' Equity" });
  await applyMigration(db, "0062", "up");
  assert.deepEqual(await names(), { total_assets: "Total Assets", total_equity: "Stockholders' Equity" }, "rerunning changes nothing");
  await applyMigration(db, "0062", "down");
  assert.deepEqual(await names(), { total_assets: "Total Assets", total_equity: "Total Equity" });
});
