import assert from "node:assert/strict";
import test from "node:test";
import { dockerAvailable } from "./docker-pg.ts";
import { applyCanonicalSchema, applyMigration, createDatabase, startServer } from "./financial-migration-helpers.ts";

const ISSUER = "0f000000-0000-4000-8000-0000000000a7";
const SOURCE = "0f000000-0000-4000-8000-0000000000c7";
const CAPEX = "0f000000-0000-4000-8000-0000000000b7";
const REVENUE = "0f000000-0000-4000-8000-0000000000b8";
const FACTS = {
  ppe: "0f000000-0000-4000-8000-0000000000d7",
  productiveAssets: "0f000000-0000-4000-8000-0000000000d8",
  revenue: "0f000000-0000-4000-8000-0000000000d9",
} as const;

test("0057 removes capex contexts recorded from another concept", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for migration coverage");
    return;
  }
  const server = await startServer(t, "capex-context-0057");
  const db = await createDatabase(t, server, "capex_context_0057");
  await applyCanonicalSchema(db);
  const fact = (id: string, metric: string, year: number) =>
    `('${id}', 'issuer', '${ISSUER}', '${metric}', 'fiscal_y', '${year}-01-01', '${year}-12-31', ${year}, 'FY', 30, 'currency', 'USD', 1,
      '2024-01-10T00:00:00Z', '2024-01-10T00:00:00Z', '2024-02-01T00:00:00Z', '${SOURCE}', 'reported', 'authoritative', 'filing_time', 'full', 1)`;
  const context = (id: string, concept: string) =>
    `('${id}', 'sec_companyfacts_context.v1', 'duration', 'consolidated', 'as_reported', 'unadjusted', 'not_applicable',
      'sec_filer_fiscal_year.v1', 'original', 'sec_edgar:companyfacts:CIK0000320190#${concept}|USD|0000320190-24-000010|2023-01-01..2023-12-31')`;
  await db.query(`
    insert into metrics (metric_id, metric_key, display_name, unit_class, aggregation, interpretation, canonical_source_class) values
      ('${CAPEX}', 'capex', 'Capital expenditures', 'currency', 'sum', 'neutral', 'gaap'),
      ('${REVENUE}', 'revenue', 'Revenue', 'currency', 'sum', 'higher_is_better', 'gaap');
    insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at) values ('${SOURCE}', 'sec_edgar', 'filing', 'primary', 'public', now());
    insert into facts (fact_id, subject_kind, subject_id, metric_id, period_kind, period_start, period_end, fiscal_year, fiscal_period,
                       value_num, unit, currency, scale, as_of, reported_at, observed_at, source_id, method,
                       verification_status, freshness_class, coverage_level, confidence) values
      ${fact(FACTS.ppe, CAPEX, 2023)}, ${fact(FACTS.productiveAssets, CAPEX, 2022)}, ${fact(FACTS.revenue, REVENUE, 2023)};
    insert into fact_financial_contexts (fact_id, context_version, period_type, dimension_scope, reporting_basis, adjustment_basis,
                                         share_basis, fiscal_calendar_version, disclosure_relation, source_context_ref) values
      ${context(FACTS.ppe, "PaymentsToAcquirePropertyPlantAndEquipment")},
      ${context(FACTS.productiveAssets, "PaymentsToAcquireProductiveAssets")},
      ${context(FACTS.revenue, "Revenues")};
  `);

  await applyMigration(db, "0057", "up");
  const remaining = (await db.query(`select fact_id::text from fact_financial_contexts order by fact_id`)).rows.map((row) => row.fact_id);
  assert.deepEqual(remaining, [FACTS.ppe, FACTS.revenue], "only the productive-asset capex context goes");
  await applyMigration(db, "0057", "down");
  await applyMigration(db, "0057", "up");
});
