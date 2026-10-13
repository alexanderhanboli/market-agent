// Cash flow, balance sheet and EPS for one company (#205 financial quality),
// built like the other fact blocks: every value is a reported fact cited by id
// and bound for the seal, so a block reads "Source-linked" from its proof.
// Free cash flow is operating cash flow less capex, minted as a derived fact
// that cites both, as margins are (#178). Nothing here is certified: a
// "Verified calculation" label still needs the financial engine's certificate.
//
// The blocks follow from what the turn asks for (research-scope.ts):
// - cash flow (operating, capex or free): the latest quarter and the latest
//   fiscal year, each a metric_row of all three;
// - the balance sheet: its latest period end;
// - EPS: diluted EPS for the latest quarter.

import { formatCompactCurrency, formatCurrency } from "../../analyze/src/block-format.ts";
import { materializeDerivedFacts } from "../../analyze/src/metrics-comparison-materializer.ts";
import { loadVerifierFactsForRefs } from "../../evidence/src/local-runtime-evidence.ts";
import {
  loadRecentIssuerFundamentals,
  type IssuerFundamentalFact,
} from "../../fundamentals/src/issuer-fundamentals-reader.ts";
import { worstCoverage } from "../../fundamentals/src/key-stats.ts";
import type { CoverageLevel, FiscalPeriod, PeriodKind } from "../../fundamentals/src/statement.ts";
import type { IssuerSubjectRef } from "../../fundamentals/src/subject-ref.ts";
import type { VerifierFact } from "../../snapshot/src/snapshot-verifier.ts";
import { blockBase, withInputs, type Block, type DerivedQuarterFact } from "./fact-blocks.ts";
import type { QuarterMetric } from "./quarter-metrics.ts";
import { STATEMENT_METRIC_LABELS, statementMetrics, type ResearchScope } from "./research-scope.ts";

type QueryExecutor = Parameters<typeof loadRecentIssuerFundamentals>[0] &
  Parameters<typeof loadVerifierFactsForRefs>[0] &
  Parameters<typeof materializeDerivedFacts>[0];

export type StatementFacets = { cashFlow: boolean; balanceSheet: boolean; eps: boolean };

const CASH_FLOW = ["operating_cash_flow", "capex"];
const BALANCE_ITEMS = [
  ["cash_and_equivalents", "Cash and equivalents"],
  ["total_assets", "Total assets"],
  ["total_liabilities", "Total liabilities"],
  ["total_equity", "Total equity"],
] as const;
const PERIOD_ORDER: Readonly<Record<string, number>> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 5 };

// What a turn's statement metrics ask to be shown.
export function statementFacets(scope: ResearchScope): StatementFacets {
  const keys = new Set(statementMetrics(scope).map((metric) => metric.metric_key));
  return {
    cashFlow: [...CASH_FLOW, "free_cash_flow"].some((key) => keys.has(key)),
    balanceSheet: keys.has("balance_sheet"),
    eps: keys.has("eps_diluted"),
  };
}

export function wantsStatements(facets: StatementFacets): boolean {
  return facets.cashFlow || facets.balanceSheet || facets.eps;
}

// Reads the facts, mints free cash flow, and builds the blocks. Empty on
// failure: a figure must never cost the user the answer.
export async function loadStatementBlocks(
  db: QueryExecutor,
  input: { issuer: IssuerSubjectRef; facets: StatementFacets; snapshotId: string; asOf: string },
): Promise<ReadonlyArray<Block>> {
  if (!wantsStatements(input.facets)) return [];
  try {
    const read = (periodKind: PeriodKind, metricKeys: ReadonlyArray<string>) =>
      metricKeys.length === 0 ? Promise.resolve([]) : loadRecentIssuerFundamentals(db, input.issuer, {
        channel: "app",
        periodKind,
        metricKeys,
        // Only what was known at the snapshot's moment, only figures, and only
        // full periods (#159, #239).
        cutoff: input.asOf,
        numericOnly: true,
        fullCoverageOnly: true,
      });
    const { cashFlow, balanceSheet, eps } = input.facets;
    const groups = await Promise.all([
      read("fiscal_q", [...(cashFlow ? CASH_FLOW : []), ...(eps ? ["eps_diluted"] : [])]),
      read("fiscal_y", cashFlow ? CASH_FLOW : []),
      read("point", balanceSheet ? BALANCE_ITEMS.map(([key]) => key) : []),
    ]);
    const facts = groups.flat();
    const verifierFacts = await loadVerifierFactsForRefs(db, {
      fact_refs: facts.map((fact) => fact.fact_id),
      cutoff: input.asOf,
      requireKnownByCutoff: true,
    });
    const derived = cashFlow ? await mintFreeCashFlow(db, input.issuer, freeCashFlowSpecs(facts, verifierFacts), input.asOf) : [];
    return buildStatementBlocks({ facts, verifierFacts, derived, facets: input.facets, snapshotId: input.snapshotId, asOf: input.asOf });
  } catch (reason) {
    console.warn("[chat] cash flow and balance sheet unavailable; answering without them", reason);
    return [];
  }
}

// Free cash flow for the latest quarter and the latest fiscal year: operating
// cash flow less capex, when both are reported for the same dates in one
// currency. The value carries its currency and cites both inputs.
export function freeCashFlowSpecs(
  facts: ReadonlyArray<IssuerFundamentalFact>,
  verifierFacts: ReadonlyArray<VerifierFact>,
): QuarterMetric[] {
  const loadable = new Map(verifierFacts.map((fact) => [fact.fact_id, fact]));
  return latestCashFlows(facts, loadable).flatMap(({ ocf, capex }) => {
    const period = loadable.get(ocf.fact_id);
    const capexPeriod = capex && loadable.get(capex.fact_id);
    if (
      !capex || !period?.period_end || !capexPeriod ||
      period.period_start !== capexPeriod.period_start ||
      period.period_end !== capexPeriod.period_end ||
      (ocf.currency ?? "USD") !== (capex.currency ?? "USD")
    ) {
      return [];
    }
    return [{
      metric: "free_cash_flow",
      label: label("free_cash_flow"),
      value_num: native(ocf) - native(capex),
      unit: "currency",
      currency: ocf.currency ?? "USD",
      as_of: [ocf.as_of, capex.as_of].sort().at(-1)!,
      source_id: ocf.source_id,
      period: {
        period_kind: (period.period_kind ?? "fiscal_q") as PeriodKind,
        period_start: period.period_start ?? null,
        period_end: period.period_end,
        fiscal_year: ocf.fiscal_year!,
        fiscal_period: ocf.fiscal_period! as FiscalPeriod,
      },
      coverage_level: worstCoverage([ocf, capex].map((fact) => ({ coverage_level: fact.coverage_level as CoverageLevel }))),
      input_fact_ids: [ocf.fact_id, capex.fact_id],
    }];
  });
}

// Minted as derived facts stamped at the cutoff (so known by it) and loaded
// back for the seal. A failure only costs free cash flow: the reported figures
// still render.
async function mintFreeCashFlow(
  db: QueryExecutor,
  issuer: IssuerSubjectRef,
  specs: ReadonlyArray<QuarterMetric>,
  asOf: string,
): Promise<DerivedQuarterFact[]> {
  if (specs.length === 0) return [];
  try {
    const ids = await materializeDerivedFacts(db, issuer.id, specs, { clock: () => new Date(asOf) });
    const bindings = new Map(
      (await loadVerifierFactsForRefs(db, { fact_refs: ids, cutoff: asOf, requireKnownByCutoff: true })).map((fact) => [fact.fact_id, fact]),
    );
    return specs.flatMap((spec, index) => {
      const binding = bindings.get(ids[index]!);
      return binding ? [{ ...spec, fact_id: ids[index]!, binding }] : [];
    });
  } catch (reason) {
    console.warn("[chat] free cash flow unavailable; showing reported cash flow only", reason);
    return [];
  }
}

export function buildStatementBlocks(input: {
  facts: ReadonlyArray<IssuerFundamentalFact>;
  verifierFacts: ReadonlyArray<VerifierFact>;
  // Free cash flow minted from these facts (freeCashFlowSpecs); none, none shown.
  derived?: ReadonlyArray<DerivedQuarterFact>;
  facets: StatementFacets;
  snapshotId: string;
  asOf: string;
}): ReadonlyArray<Block> {
  // Only facts the seal can load and bind may render.
  const loadable = new Map(input.verifierFacts.map((fact) => [fact.fact_id, fact]));
  const facts = input.facts.filter((fact) => loadable.has(fact.fact_id) && fact.value_num !== null);
  const derived = input.derived ?? [];
  for (const fact of derived) loadable.set(fact.fact_id, fact.binding);
  const blocks: Block[] = [];

  if (input.facets.cashFlow) {
    for (const { ocf, capex } of latestCashFlows(facts, loadable)) {
      const fcf = derived.find((fact) => fact.input_fact_ids.includes(ocf.fact_id));
      const reported = capex ? [ocf, capex] : [ocf];
      const shown = fcf ? [fcf] : [];
      blocks.push({
        ...blockBase("metric_row", input, withInputs([...reported, ...shown], shown, loadable), loadable, `cash_flow_${ocf.fiscal_period === "FY" ? "year" : "quarter"}`),
        title: `Cash flow (${periodLabel(ocf)})`,
        items: [
          ...reported.map((fact) => ({ label: label(fact.metric_key), value_ref: fact.fact_id, format: money(native(fact), fact.currency) })),
          ...shown.map((fact) => ({ label: label("free_cash_flow"), value_ref: fact.fact_id, format: money(fact.value_num, fact.currency ?? null) })),
        ],
      });
    }
  }

  if (input.facets.balanceSheet) {
    // The balances at the latest period end any of them has.
    const endOf = (fact: IssuerFundamentalFact) => loadable.get(fact.fact_id)?.period_end ?? "";
    const balances = facts.filter((fact) => BALANCE_ITEMS.some(([key]) => key === fact.metric_key) && endOf(fact) !== "");
    const end = balances.map(endOf).sort().at(-1);
    const items = end === undefined ? [] : BALANCE_ITEMS.flatMap(([key, itemLabel]) => {
      const fact = balances.find((row) => row.metric_key === key && endOf(row) === end);
      return fact ? [{ fact, itemLabel }] : [];
    });
    if (end !== undefined && items.length > 0) {
      blocks.push({
        ...blockBase("metric_row", input, items.map(({ fact }) => fact), loadable, "balance_sheet"),
        title: `Balance sheet (${monthYear(end)})`,
        items: items.map(({ fact, itemLabel }) => ({ label: itemLabel, value_ref: fact.fact_id, format: money(native(fact), fact.currency) })),
      });
    }
  }

  if (input.facets.eps) {
    const latest = latestPeriod(facts.filter((fact) => fact.metric_key === "eps_diluted" && fact.fiscal_period !== "FY"));
    if (latest) {
      blocks.push({
        ...blockBase("metric_row", input, [latest], loadable, "eps"),
        title: `Earnings per share (${periodLabel(latest)})`,
        items: [{ label: label("eps_diluted"), value_ref: latest.fact_id, format: formatCurrency(native(latest), latest.currency ?? "USD") }],
      });
    }
  }
  return Object.freeze(blocks);
}

// The latest quarter's and the latest fiscal year's operating cash flow, each
// with capex for the same period when reported.
function latestCashFlows(
  facts: ReadonlyArray<IssuerFundamentalFact>,
  loadable: ReadonlyMap<string, VerifierFact>,
): Array<{ ocf: IssuerFundamentalFact; capex: IssuerFundamentalFact | undefined }> {
  const usable = facts.filter((fact) => loadable.has(fact.fact_id) && fact.value_num !== null);
  return [false, true].flatMap((annual) => {
    const ocf = latestPeriod(usable.filter((fact) => fact.metric_key === "operating_cash_flow" && (fact.fiscal_period === "FY") === annual));
    if (!ocf) return [];
    const capex = usable.find((fact) =>
      fact.metric_key === "capex" && fact.fiscal_year === ocf.fiscal_year && fact.fiscal_period === ocf.fiscal_period
    );
    return [{ ocf, capex }];
  });
}

function latestPeriod(rows: ReadonlyArray<IssuerFundamentalFact>): IssuerFundamentalFact | undefined {
  return [...rows].sort((a, b) =>
    (b.fiscal_year! - a.fiscal_year!) || ((PERIOD_ORDER[b.fiscal_period!] ?? 0) - (PERIOD_ORDER[a.fiscal_period!] ?? 0))
  )[0];
}

function periodLabel(fact: IssuerFundamentalFact): string {
  return fact.fiscal_period === "FY" ? `FY${fact.fiscal_year}` : `${fact.fiscal_period} ${fact.fiscal_year}`;
}

function monthYear(isoDate: string): string {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function label(metricKey: string): string {
  return STATEMENT_METRIC_LABELS[metricKey]![0]!;
}

function money(value: number, currency: string | null): string {
  return formatCompactCurrency(value, currency ?? "USD");
}

function native(fact: IssuerFundamentalFact): number {
  return fact.value_num! * fact.scale;
}
