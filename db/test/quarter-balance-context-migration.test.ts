import assert from "node:assert/strict";
import test from "node:test";
import { dockerAvailable } from "./docker-pg.ts";
import { applyCanonicalSchema, applyMigration, createDatabase, startServer } from "./financial-migration-helpers.ts";

const ISSUER = "0f000000-0000-4000-8000-0000000000a9";
const OTHER_ISSUER = "0f000000-0000-4000-8000-0000000000aa";
const SOURCES = {
  annual: "0f000000-0000-4000-8000-0000000000c9",
  quarter: "0f000000-0000-4000-8000-0000000000ca",
  fourthQuarterOnly: "0f000000-0000-4000-8000-0000000000cb",
  restating: "0f000000-0000-4000-8000-0000000000cc",
} as const;
const REVENUE = "0f000000-0000-4000-8000-0000000000bb";
const ASSETS = "0f000000-0000-4000-8000-0000000000bc";
const FACTS = {
  annualRevenue: "0f000000-0000-4000-8000-0000000000e1",
  annualFourthQuarter: "0f000000-0000-4000-8000-0000000000e2",
  annualAssets: "0f000000-0000-4000-8000-0000000000e3",
  annualAssetsRestated: "0f000000-0000-4000-8000-0000000000e4",
  quarterRevenue: "0f000000-0000-4000-8000-0000000000e5",
  quarterAssets: "0f000000-0000-4000-8000-0000000000e6",
  quarterAssetsRestated: "0f000000-0000-4000-8000-0000000000e7",
  fourthQuarterOnly: "0f000000-0000-4000-8000-0000000000e8",
  fourthQuarterOnlyAssets: "0f000000-0000-4000-8000-0000000000e9",
} as const;

type Fact = {
  id: string;
  subject?: string;
  metric: string;
  kind: "fiscal_y" | "fiscal_q" | "point";
  start: string | null;
  end: string;
  year: number;
  period: string;
  source: string;
  supersedes?: string;
};

test("0061 removes the contexts of balances certified from a 10-Q", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for migration coverage");
    return;
  }
  const server = await startServer(t, "quarter-balance-0061");
  const db = await createDatabase(t, server, "quarter_balance_0061");
  await applyCanonicalSchema(db);
  const facts: Fact[] = [
    // A 10-K: the year, its derived fourth quarter, and the year-end balance.
    { id: FACTS.annualRevenue, metric: REVENUE, kind: "fiscal_y", start: "2024-01-01", end: "2024-12-31", year: 2024, period: "FY", source: SOURCES.annual },
    { id: FACTS.annualFourthQuarter, metric: REVENUE, kind: "fiscal_q", start: "2024-10-01", end: "2024-12-31", year: 2024, period: "Q4", source: SOURCES.annual },
    { id: FACTS.annualAssets, metric: ASSETS, kind: "point", start: null, end: "2024-12-31", year: 2024, period: "FY", source: SOURCES.annual },
    // A 10-Q: its quarter, and its balance stored as FY at the quarter's end.
    { id: FACTS.quarterRevenue, metric: REVENUE, kind: "fiscal_q", start: "2025-01-01", end: "2025-03-31", year: 2025, period: "Q1", source: SOURCES.quarter },
    { id: FACTS.quarterAssets, metric: ASSETS, kind: "point", start: null, end: "2025-03-31", year: 2025, period: "FY", source: SOURCES.quarter },
    // A 10-K ingested only for its fourth quarter: no fiscal-year fact in its source.
    { id: FACTS.fourthQuarterOnly, subject: OTHER_ISSUER, metric: REVENUE, kind: "fiscal_q", start: "2024-10-01", end: "2024-12-31", year: 2024, period: "Q4", source: SOURCES.fourthQuarterOnly },
    { id: FACTS.fourthQuarterOnlyAssets, subject: OTHER_ISSUER, metric: ASSETS, kind: "point", start: null, end: "2024-12-31", year: 2024, period: "FY", source: SOURCES.fourthQuarterOnly },
    // A later 10-K restating each balance.
    { id: FACTS.annualAssetsRestated, metric: ASSETS, kind: "point", start: null, end: "2024-12-31", year: 2024, period: "FY", source: SOURCES.restating, supersedes: FACTS.annualAssets },
    { id: FACTS.quarterAssetsRestated, metric: ASSETS, kind: "point", start: null, end: "2025-03-31", year: 2025, period: "FY", source: SOURCES.restating, supersedes: FACTS.quarterAssets },
  ];
  const certified = new Set<string>([
    FACTS.annualRevenue, FACTS.annualAssets, FACTS.annualAssetsRestated, FACTS.quarterRevenue,
    FACTS.quarterAssets, FACTS.quarterAssetsRestated, FACTS.fourthQuarterOnlyAssets,
  ]);
  const date = (value: string | null) => (value === null ? "null" : `'${value}'`);
  const factRow = (fact: Fact) =>
    `('${fact.id}', 'issuer', '${fact.subject ?? ISSUER}', '${fact.metric}', '${fact.kind}', ${date(fact.start)}, '${fact.end}', ${fact.year}, '${fact.period}',
      30, 'currency', 'USD', 1, '2025-06-01T00:00:00Z', '2025-06-01T00:00:00Z', '2025-06-01T00:00:00Z', '${fact.source}',
      '${fact.supersedes ? "restated" : "reported"}', 'authoritative', 'filing_time', 'full', 1, ${fact.supersedes ? `'${fact.supersedes}'` : "null"})`;
  const contextRow = (fact: Fact) =>
    `('${fact.id}', 'sec_companyfacts_context.v1', '${fact.start === null ? "instant" : "duration"}', 'consolidated',
      '${fact.supersedes ? "as_restated" : "as_reported"}', 'unadjusted', 'not_applicable', 'sec_filer_fiscal_year.v1',
      '${fact.supersedes ? "economic_restatement" : "original"}', 'sec_edgar:companyfacts:CIK0000320190#Assets|USD|0000320190-25-000010|..${fact.end}')`;
  await db.query(`
    insert into metrics (metric_id, metric_key, display_name, unit_class, aggregation, interpretation, canonical_source_class) values
      ('${REVENUE}', 'revenue', 'Revenue', 'currency', 'sum', 'higher_is_better', 'gaap'),
      ('${ASSETS}', 'total_assets', 'Total assets', 'currency', 'point_in_time', 'neutral', 'gaap');
    insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at) values
      ${Object.values(SOURCES).map((source) => `('${source}', 'sec_edgar', 'filing', 'primary', 'public', now())`).join(", ")};
    insert into facts (fact_id, subject_kind, subject_id, metric_id, period_kind, period_start, period_end, fiscal_year, fiscal_period,
                       value_num, unit, currency, scale, as_of, reported_at, observed_at, source_id, method,
                       verification_status, freshness_class, coverage_level, confidence, supersedes) values
      ${facts.map(factRow).join(",\n")};
    insert into fact_financial_contexts (fact_id, context_version, period_type, dimension_scope, reporting_basis, adjustment_basis,
                                         share_basis, fiscal_calendar_version, disclosure_relation, source_context_ref) values
      ${facts.filter((fact) => certified.has(fact.id)).map(contextRow).join(",\n")};
  `);

  await applyMigration(db, "0061", "up");
  const remaining = (await db.query(`select fact_id::text from fact_financial_contexts order by fact_id`)).rows.map((row) => row.fact_id);
  assert.deepEqual(remaining, [
    FACTS.annualRevenue,
    FACTS.annualAssets,
    FACTS.annualAssetsRestated,
    FACTS.quarterRevenue,
    FACTS.fourthQuarterOnlyAssets,
  ], "only the 10-Q balance and its restatement lose their contexts");
  const stored = (await db.query(`select count(*)::int as n from facts`)).rows[0]!.n;
  assert.equal(stored, facts.length, "every fact stays");
  await applyMigration(db, "0061", "down");
  await applyMigration(db, "0061", "up");
});
