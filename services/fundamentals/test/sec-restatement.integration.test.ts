// SEC restatements (#321): a later 10-K's changed value for an earlier year is
// stored as that year's restatement, and as-reported readers never see it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bootstrapDatabase, connectedPool, dockerAvailable, workspaceRoot } from "../../../db/test/docker-pg.ts";
import { createSecBackedStatementRepository } from "../src/sec-facts-repository.ts";
import { secCompanyFetcher } from "./fakes.ts";
import { selectRevenue } from "./financial-selection.ts";

const ISSUER_ID = "33000000-0000-4000-8000-0000000003a1";
const FALLBACK_SOURCE_ID = "33000000-0000-4000-8000-0000000003a2";
const FY2023 = "0000320190-24-000010";
const FY2024 = "0000320190-25-000010";
const FY2025 = "0000320190-26-000010";

type Value = { start: string; end: string; val: number; val_token: string; accn: string; fy: number; fp: string; form: string; filed: string };
const year = (accn: string, fy: number, filed: string) => (calendarYear: number, token: string): Value =>
  ({ start: `${calendarYear}-01-01`, end: `${calendarYear}-12-31`, val: Number(token), val_token: token, accn, fy, fp: "FY", form: "10-K", filed });

/** Companyfacts as SEC lists it after each 10-K: every filing's values, own year and comparatives. */
function companyFacts(filings: number) {
  const k23 = year(FY2023, 2023, "2024-01-10");
  const k24 = year(FY2024, 2024, "2025-01-10");
  const k25 = year(FY2025, 2025, "2026-01-10");
  const revenue = [k23(2023, "100"), ...(filings > 1 ? [k24(2023, "95"), k24(2024, "110")] : []), ...(filings > 2 ? [k25(2023, "95"), k25(2024, "110"), k25(2025, "120")] : [])];
  const netIncome = [k23(2023, "40"), ...(filings > 1 ? [k24(2023, "40"), k24(2024, "44")] : [])];
  // FY2024's 10-K gives operating income for 2023 twice, with different values.
  const operatingIncome = [k23(2023, "20"), ...(filings > 1 ? [k24(2023, "18"), k24(2023, "19"), k24(2024, "22")] : [])];
  return {
    cik: 320190,
    entityName: "Restating Corp",
    facts: {
      "us-gaap": {
        Revenues: { label: "", description: "", units: { USD: revenue } },
        NetIncomeLoss: { label: "", description: "", units: { USD: netIncome } },
        OperatingIncomeLoss: { label: "", description: "", units: { USD: operatingIncome } },
      },
    },
  };
}

test("SEC restatements", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for restatement coverage");
    return;
  }
  const { databaseUrl } = await bootstrapDatabase(t, "fin-sec-restatement");
  const db = await connectedPool(t, databaseUrl);
  await db.query(await readFile(join(workspaceRoot, "db", "seed", "metrics.sql"), "utf8"));
  await db.query(`insert into issuers (issuer_id, legal_name, cik) values ($1, 'Restating Corp', '320190')`, [ISSUER_ID]);
  const ingest = (filings: number, fiscalYear: number, completedAt: string) =>
    createSecBackedStatementRepository(db, {
      fetcher: secCompanyFetcher(() => companyFacts(filings), { completed_at: completedAt }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    }).find({ issuer_id: ISSUER_ID, family: "income", basis: "as_reported", fiscal_year: fiscalYear, fiscal_period: "FY" });
  const fy2023Facts = async () => (await db.query(
    `select m.metric_key, f.method::text as method, f.value_num::text as value, c.reporting_basis, c.disclosure_relation,
            (select o.method::text from facts o where o.fact_id = f.supersedes) as restates
       from facts f join metrics m on m.metric_id = f.metric_id left join fact_financial_contexts c on c.fact_id = f.fact_id
      where f.subject_id = $1 and f.fiscal_year = 2023 order by m.metric_key, f.method`,
    [ISSUER_ID],
  )).rows;
  const picked = (selection: Awaited<ReturnType<typeof selectRevenue>>) =>
    selection.status === "selected" ? selection.input.candidate.value_text : selection.reason_code;

  await t.test("a changed comparative is a restatement; an unchanged or conflicting one adds nothing", async () => {
    await ingest(1, 2023, "2024-02-01T15:00:00.000Z");
    await ingest(2, 2024, "2025-02-01T15:00:00.000Z");
    assert.deepEqual(await fy2023Facts(), [
      { metric_key: "net_income", method: "reported", value: "40", reporting_basis: "as_reported", disclosure_relation: "original", restates: null },
      { metric_key: "operating_income", method: "reported", value: "20", reporting_basis: "as_reported", disclosure_relation: "original", restates: null },
      { metric_key: "revenue", method: "reported", value: "100", reporting_basis: "as_reported", disclosure_relation: "original", restates: null },
      { metric_key: "revenue", method: "restated", value: "95", reporting_basis: "as_restated", disclosure_relation: "economic_restatement", restates: "reported" },
    ]);
  });

  await t.test("as-reported and as-restated selections pick different facts, each only once public", async () => {
    assert.equal(picked(await selectRevenue(db, ISSUER_ID, "2025-03-01T00:00:00Z", "as_reported")), "100");
    assert.equal(picked(await selectRevenue(db, ISSUER_ID, "2025-03-01T00:00:00Z", "as_restated")), "95");
    assert.equal(picked(await selectRevenue(db, ISSUER_ID, "2024-06-01T00:00:00Z", "as_restated")), "100", "the restatement was not public yet");
  });

  await t.test("the as-reported statement keeps the original", async () => {
    const statement = await createSecBackedStatementRepository(db, { fetcher: null, sourceId: FALLBACK_SOURCE_ID })
      .find({ issuer_id: ISSUER_ID, family: "income", basis: "as_reported", fiscal_year: 2023, fiscal_period: "FY" });
    assert.equal(statement?.lines.find((line) => line.metric_key === "revenue")?.value_num, 100);
  });

  await t.test("re-ingesting, or a later 10-K repeating the restated value, adds no restatement", async () => {
    await ingest(2, 2024, "2025-03-01T15:00:00.000Z");
    await ingest(3, 2025, "2026-02-01T15:00:00.000Z");
    assert.equal((await fy2023Facts()).filter((row) => row.method === "restated").length, 1);
  });
});
