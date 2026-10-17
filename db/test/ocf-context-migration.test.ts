import assert from "node:assert/strict";
import test from "node:test";
import { dockerAvailable } from "./docker-pg.ts";
import { applyCanonicalSchema, applyMigration, createDatabase, startServer } from "./financial-migration-helpers.ts";

const ISSUER = "0f000000-0000-4000-8000-0000000000a8";
const SOURCE = "0f000000-0000-4000-8000-0000000000c8";
const OCF = "0f000000-0000-4000-8000-0000000000b9";
const CAPEX = "0f000000-0000-4000-8000-0000000000ba";
const FACTS = {
  total: "0f000000-0000-4000-8000-0000000000da",
  continuing: "0f000000-0000-4000-8000-0000000000db",
  capex: "0f000000-0000-4000-8000-0000000000dc",
} as const;

test("0060 removes OCF contexts recorded from the continuing-operations concept", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for migration coverage");
    return;
  }
  const server = await startServer(t, "ocf-context-0060");
  const db = await createDatabase(t, server, "ocf_context_0060");
  await applyCanonicalSchema(db);
  const fact = (id: string, metric: string, year: number) =>
    `('${id}', 'issuer', '${ISSUER}', '${metric}', 'fiscal_y', '${year}-01-01', '${year}-12-31', ${year}, 'FY', 30, 'currency', 'USD', 1,
      '2024-01-10T00:00:00Z', '2024-01-10T00:00:00Z', '2024-02-01T00:00:00Z', '${SOURCE}', 'reported', 'authoritative', 'filing_time', 'full', 1)`;
  const context = (id: string, concept: string) =>
    `('${id}', 'sec_companyfacts_context.v1', 'duration', 'consolidated', 'as_reported', 'unadjusted', 'not_applicable',
      'sec_filer_fiscal_year.v1', 'original', 'sec_edgar:companyfacts:CIK0000320190#${concept}|USD|0000320190-24-000010|2023-01-01..2023-12-31')`;
  await db.query(`
    insert into metrics (metric_id, metric_key, display_name, unit_class, aggregation, interpretation, canonical_source_class) values
      ('${OCF}', 'operating_cash_flow', 'Operating cash flow', 'currency', 'sum', 'higher_is_better', 'gaap'),
      ('${CAPEX}', 'capex', 'Capital expenditures', 'currency', 'sum', 'neutral', 'gaap');
    insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at) values ('${SOURCE}', 'sec_edgar', 'filing', 'primary', 'public', now());
    insert into facts (fact_id, subject_kind, subject_id, metric_id, period_kind, period_start, period_end, fiscal_year, fiscal_period,
                       value_num, unit, currency, scale, as_of, reported_at, observed_at, source_id, method,
                       verification_status, freshness_class, coverage_level, confidence) values
      ${fact(FACTS.total, OCF, 2023)}, ${fact(FACTS.continuing, OCF, 2022)}, ${fact(FACTS.capex, CAPEX, 2023)};
    insert into fact_financial_contexts (fact_id, context_version, period_type, dimension_scope, reporting_basis, adjustment_basis,
                                         share_basis, fiscal_calendar_version, disclosure_relation, source_context_ref) values
      ${context(FACTS.total, "NetCashProvidedByUsedInOperatingActivities")},
      ${context(FACTS.continuing, "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations")},
      ${context(FACTS.capex, "PaymentsToAcquirePropertyPlantAndEquipment")};
  `);

  await applyMigration(db, "0060", "up");
  const remaining = (await db.query(`select fact_id::text from fact_financial_contexts order by fact_id`)).rows.map((row) => row.fact_id);
  assert.deepEqual(remaining, [FACTS.total, FACTS.capex], "only the continuing-operations OCF context goes");
  await applyMigration(db, "0060", "down");
  await applyMigration(db, "0060", "up");
});
