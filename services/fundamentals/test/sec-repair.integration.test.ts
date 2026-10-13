import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bootstrapDatabase, connectedPool, dockerAvailable, workspaceRoot } from "../../../db/test/docker-pg.ts";
import { createSecCompanyFactsHttpFetcher } from "../src/sec-edgar-http.ts";
import { backfillSecCompanionStatements, createSecBackedStatementRepository } from "../src/sec-facts-repository.ts";
import { loadUsableFacts } from "../src/usable-facts.ts";

const ISSUER_ID = "32000000-0000-4000-8000-000000000001";
const FALLBACK_SOURCE_ID = "32000000-0000-4000-8000-000000000003";

// AAPL's FY2024 10-K as data.sec.gov lists it: the two prior years first.
function companyFactsText(): string {
  const fy = (val: number, start: string, end: string) =>
    `{"start":"${start}","end":"${end}","val":${val},"accn":"0000320193-24-000123","fy":2024,"fp":"FY","form":"10-K","filed":"2024-11-01"}`;
  const years = (a: number, b: number, c: number) =>
    `[${fy(a, "2021-09-26", "2022-09-24")},${fy(b, "2022-09-25", "2023-09-30")},${fy(c, "2023-10-01", "2024-09-28")}]`;
  return `{"cik":320193,"entityName":"Apple Inc.","facts":{"us-gaap":{
    "RevenueFromContractWithCustomerExcludingAssessedTax":{"label":"","description":"","units":{"USD":${years(394328000000, 383285000000, 391035000000)}}},
    "NetIncomeLoss":{"label":"","description":"","units":{"USD":${years(99803000000, 96995000000, 93736000000)}}}
  }}}`;
}

test("the backfill replaces an income fact the old selector got wrong, keeping history at earlier cutoffs", { timeout: 180_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for repair coverage");
    return;
  }
  const { databaseUrl } = await bootstrapDatabase(t, "fin-sec-repair");
  const db = await connectedPool(t, databaseUrl);
  await db.query(await readFile(join(workspaceRoot, "db", "seed", "metrics.sql"), "utf8"));
  await db.query(`insert into issuers (issuer_id, legal_name, cik) values ($1, 'Apple Inc.', '320193')`, [ISSUER_ID]);
  const fetcher = createSecCompanyFactsHttpFetcher({
    userAgent: "market-agent-test test@example.invalid",
    fetchImpl: async () => new Response(companyFactsText(), { status: 200 }),
  });
  const lookup = { issuer_id: ISSUER_ID, family: "income" as const, basis: "as_reported" as const, fiscal_year: 2024, fiscal_period: "FY" as const };
  await createSecBackedStatementRepository(db, {
    fetcher,
    sourceId: FALLBACK_SOURCE_ID,
    clock: () => new Date("2024-11-02T00:00:00.000Z"),
    logger: { warn: () => {} },
  }).find(lookup);

  // What the old selector stored: the 10-K's oldest comparative as FY2024.
  await db.query(
    `update facts f set value_num = 394328000000, period_start = '2021-09-26', period_end = '2022-09-24'
       from metrics m where m.metric_id = f.metric_id and m.metric_key = 'revenue' and f.subject_id = $1`,
    [ISSUER_ID],
  );
  const factOf = async (metricKey: string) => (await db.query<{ fact_id: string; value: string; invalidated: boolean; superseded_by: string | null }>(
    `select f.fact_id::text as fact_id, f.value_num::text as value, f.invalidated_at is not null as invalidated, f.superseded_by::text as superseded_by
       from facts f join metrics m on m.metric_id = f.metric_id
      where f.subject_id = $1 and m.metric_key = $2 order by f.created_at`,
    [ISSUER_ID, metricKey],
  )).rows;
  const [wrong] = await factOf("revenue");
  const [netIncome] = await factOf("net_income");

  await backfillSecCompanionStatements(db, {
    issuerId: ISSUER_ID,
    fetcher,
    sourceId: FALLBACK_SOURCE_ID,
    clock: () => new Date("2024-12-01T00:00:00.000Z"),
    logger: { warn: () => {} },
  });

  const revenue = await factOf("revenue");
  assert.equal(revenue.length, 2);
  const replacement = revenue.find((row) => !row.invalidated)!;
  assert.equal(replacement.value, "391035000000");
  assert.deepEqual(revenue.find((row) => row.fact_id === wrong!.fact_id), { ...wrong, invalidated: true, superseded_by: replacement.fact_id });
  // A fact that was right is left as it was.
  assert.deepEqual(await factOf("net_income"), [netIncome]);

  // Reads now see the replacement; a snapshot cut before the repair still sees what was known then.
  const usable = (cutoff?: string) => loadUsableFacts(db, {
    subjectKind: "issuer",
    subjectIds: [ISSUER_ID],
    metricKeys: ["revenue"],
    ...(cutoff ? { cutoff } : {}),
  });
  assert.deepEqual((await usable()).map((fact) => fact.value_num), [391035000000]);
  assert.deepEqual((await usable("2024-11-15T00:00:00.000Z")).map((fact) => fact.value_num), [394328000000]);
  const reread = await createSecBackedStatementRepository(db, { fetcher: null, sourceId: FALLBACK_SOURCE_ID }).find(lookup);
  assert.equal(reread?.lines.find((line) => line.metric_key === "revenue")?.value_num, 391035000000);
  // A statement read back from facts keeps its dates in any local time zone.
  assert.equal(reread?.period_start, "2023-10-01");
  assert.equal(reread?.period_end, "2024-09-28");
});
