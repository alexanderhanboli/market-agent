import assert from "node:assert/strict";
import test from "node:test";
import { dockerAvailable } from "./docker-pg.ts";
import { applyCanonicalSchema, applyMigration, createDatabase, expectRejected, startServer } from "./financial-migration-helpers.ts";

const SOURCE = "0f000000-0000-4000-8000-0000000000c9";

function insertAcceptance(overrides: Record<string, string> = {}): string {
  const values = {
    source_id: `'${SOURCE}'`,
    accession: "'0000320193-24-000006'",
    raw_value: "'2024-01-10T16:30:05.000Z'",
    parsed_at: "'2024-01-10T21:30:05Z'",
    timing_precision: "'instant'",
    source_timezone: "'America/New_York'",
    evidence_ref: "'https://data.sec.gov/submissions/CIK0000320193.json'",
    evidence_hash: `'${"a".repeat(64)}'`,
    ...overrides,
  };
  return `insert into sec_filing_acceptances (${Object.keys(values).join(", ")}) values (${Object.values(values).join(", ")}) returning acceptance_id`;
}

test("0056 SEC filing acceptances", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for migration coverage");
    return;
  }
  const server = await startServer(t, "sec-acceptance-0056");
  const db = await createDatabase(t, server, "acceptances_0056");
  await applyCanonicalSchema(db);
  await db.query(`insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at) values ('${SOURCE}', 'sec_edgar', 'filing', 'primary', 'public', now())`);

  await t.test("a parsed value carries its precision; a conflict or malformed value carries neither", async () => {
    assert.equal((await db.query(insertAcceptance())).rowCount, 1);
    assert.equal((await db.query(insertAcceptance({ parsed_at: "null", timing_precision: "null", conflicts: `'["2024-01-11T09:00:00.000Z"]'` }))).rowCount, 1);
    await expectRejected(db, insertAcceptance({ timing_precision: "null" }), /sec_filing_acceptances_parsed/);
    await expectRejected(db, insertAcceptance({ conflicts: `'["2024-01-11T09:00:00.000Z"]'` }), /sec_filing_acceptances_conflicts/);
    await expectRejected(db, insertAcceptance({ accession: "'320193-24-6'" }), /accession/);
    await expectRejected(db, insertAcceptance({ timing_precision: "'observed_public'" }), /timing_precision/);
  });

  await t.test("rows are append-only", async () => {
    await expectRejected(db, `update sec_filing_acceptances set raw_value = 'x'`, /append-only/);
  });

  await t.test("down drops the table and up restores it", async () => {
    await applyMigration(db, "0056", "down");
    assert.equal((await db.query(`select to_regclass('sec_filing_acceptances') as name`)).rows[0].name, null);
    await applyMigration(db, "0056", "up");
    assert.equal((await db.query(`select to_regclass('sec_filing_acceptances')::text as name`)).rows[0].name, "sec_filing_acceptances");
  });
});
