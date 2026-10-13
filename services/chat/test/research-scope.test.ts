import test from "node:test";
import assert from "node:assert/strict";

import { parseResearchScope, requestedMetrics, resolveResearchScope, type ResearchScope } from "../src/research-scope.ts";

const NVDA = { issuer_id: "60000000-0000-4000-8000-000000000001", label: "NVDA" };
const AMD = { issuer_id: "60000000-0000-4000-8000-000000000002", label: "AMD" };
const AS_OF = "2026-09-01T00:00:00.000Z";

const fresh = (question: string, companies: ResearchScope["companies"] = [NVDA]) =>
  resolveResearchScope({ question, companies, prior: null, asOf: AS_OF });

test("each recurring question takes its own route", () => {
  const cases: Array<[string, ResearchScope["companies"], ResearchScope["route"]]> = [
    ["Analyze NVDA's latest quarter.", [NVDA], "latest_quarter"],
    ["How have NVDA's operating margins trended?", [NVDA], "trend"],
    ["What changed in NVDA's gross margin in Q1 fiscal 2026?", [NVDA], "trend"],
    ["What is NVDA's gross margin?", [NVDA], "derived_margin"],
    // A comparison with an earlier period needs the margins over time.
    ["Show AMD operating margins QoQ", [AMD], "trend"],
    ["Compare AMD gross margin with last quarter", [AMD], "trend"],
    ["What is AMD's EBITDA?", [AMD], "unavailable_metric"],
    // Cash flow, the balance sheet and EPS, for one company.
    ["What is AMD's free cash flow?", [AMD], "statements"],
    ["How much cash does AMD have on its balance sheet?", [AMD], "statements"],
    ["What was NVDA's EPS?", [NVDA], "statements"],
    ["What are AMD's free cash flow and EBITDA?", [AMD], "statements"],
    // Statement figures are one company at a time: a comparison asking only for
    // them is a named gap, with no income figures in their place.
    ["Compare NVDA and AMD free cash flow", [NVDA, AMD], "unavailable_metric"],
    ["Compare NVDA and AMD EPS", [NVDA, AMD], "unavailable_metric"],
    // A request that is partly available takes its usual route; the rest is a named gap.
    ["Compare NVDA and AMD revenue and free cash flow", [NVDA, AMD], "comparison"],
    ["What is NVDA's revenue and free cash flow?", [NVDA], "latest_quarter"],
    ["Break down NVDA's revenue by segment.", [NVDA], "segments"],
    ["Compare NVDA with AMD.", [NVDA, AMD], "comparison"],
    ["How does NVDA compare with its peers?", [NVDA], "comparison"],
    ["What is the market doing?", [], "unknown"],
  ];
  for (const [question, companies, route] of cases) {
    assert.equal(fresh(question, companies).route, route, question);
  }
});

test("a fresh question records what it asks for and inherits nothing", () => {
  assert.deepEqual(fresh("Compare NVDA's and AMD's fiscal 2025 revenue YTD", [NVDA, AMD]), {
    route: "comparison",
    reads: "comparison",
    companies: [NVDA, AMD],
    peers: false,
    segments: false,
    margin_trend: false,
    margins: false,
    metrics: [{ metric_key: "income_statement", label: "Revenue, profit and margins", available: true }],
    fiscal_year: 2025,
    price_window: { kind: "ytd", cutoff: AS_OF },
    benchmark: false,
    // Which of the income statement it names.
    income_items: ["revenue"],
    inherited: [],
  });
});

test("a follow-up keeps the window, year and facets it does not change", () => {
  const prior = fresh("Compare NVDA with AMD fiscal 2025 margin trends YTD", [NVDA, AMD]);
  const next = resolveResearchScope({
    question: "Explain the differences and show the evidence",
    companies: [NVDA, AMD],
    prior,
    asOf: "2026-09-02T00:00:00.000Z",
  });
  // The window keeps the cutoff it was charted at, not this turn's.
  assert.deepEqual(next.price_window, { kind: "ytd", cutoff: AS_OF });
  assert.equal(next.fiscal_year, 2025);
  assert.equal(next.margin_trend, true);
  assert.deepEqual(next.inherited, ["margin_trend", "metrics", "fiscal_year", "price_window"]);
  // It asks for the previous answer's evidence about the same companies.
  assert.equal(next.route, "evidence_followup");
});

test("a follow-up that names a field replaces only that field", () => {
  const prior = fresh("Compare NVDA with AMD fiscal 2025 YTD", [NVDA, AMD]);
  const next = resolveResearchScope({
    question: "Now for fiscal 2026",
    companies: [NVDA, AMD],
    prior,
    asOf: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(next.fiscal_year, 2026);
  assert.deepEqual(next.price_window, { kind: "ytd", cutoff: AS_OF });
  assert.deepEqual(next.inherited, ["price_window"]);
});

test("a window asked for again is cut off at the new turn", () => {
  const prior = fresh("Compare NVDA with AMD YTD", [NVDA, AMD]);
  const later = "2026-09-02T00:00:00.000Z";
  const next = resolveResearchScope({ question: "And YTD now?", companies: [NVDA, AMD], prior, asOf: later });
  assert.deepEqual(next.price_window, { kind: "ytd", cutoff: later });
  assert.deepEqual(next.inherited, []);
});

test("guidance is asked for by the turn's own words, not carried to the next", () => {
  const asked = fresh("What revenue guidance did NVDA give?", [NVDA]);
  assert.equal(asked.guidance, true);
  // Asked as an expectation, a projection or a target too.
  for (const question of [
    "What revenue does NVDA expect next quarter?",
    "What revenue is NVDA expected to report next quarter?",
    "What are management's projections?",
    "What does NVDA project for revenue next quarter?",
    "What are management's revenue expectations?",
    "What is NVDA guiding for revenue next quarter?",
    "What does NVDA's management guide to?",
    // Guidance set against guidance is still guidance.
    "How does NVDA's current revenue guidance compare versus prior guidance?",
    "What is NVDA's gross margin target?",
  ]) {
    assert.equal(fresh(question, [NVDA]).guidance, true, question);
  }
  // A result set against past expectations asks why, not for guidance.
  for (const question of [
    "Why were NVDA's margins lower than expected?",
    "Did NVDA's revenue come in as expected?",
    "Why did NVDA's revenue miss its forecast?",
    "Why were NVDA's margins below target?",
    "Why did NVDA beat its guidance?",
    "Why did NVDA's revenue miss the company's guidance?",
    "Why did NVDA's revenue miss expectations?",
    "Why did NVDA's revenue come in below the low end of guidance?",
    "Why was NVDA's gross margin above the high end of its outlook?",
    // Turned off.
    "Why did NVDA's revenue fall, without using guidance?",
    "Explain NVDA's margin decline, no forecasts please",
  ]) {
    assert.equal(fresh(question, [NVDA]).guidance, undefined, question);
  }
  assert.equal(fresh("What was NVDA's revenue?", [NVDA]).guidance, undefined);
  const next = resolveResearchScope({ question: "And its gross margin?", companies: [NVDA], prior: asked, asOf: AS_OF });
  assert.equal(next.guidance, undefined);
  // An evidence follow-up re-reads the answer it asks about, guidance first too.
  const sources = resolveResearchScope({ question: "What are your sources?", companies: [NVDA], prior: asked, asOf: AS_OF });
  assert.equal(sources.route, "evidence_followup");
  assert.equal(sources.guidance, true);
  // Unless it turns guidance off.
  const without = resolveResearchScope({ question: "What are your sources, but without guidance?", companies: [NVDA], prior: asked, asOf: AS_OF });
  assert.equal(without.route, "evidence_followup");
  assert.equal(without.guidance, undefined);
  assert.deepEqual(sources.income_items, ["revenue"]);
  // Any other turn names its own; one that names none, and keeps the metrics
  // it asked about, keeps its items too.
  assert.deepEqual(next.income_items, ["gross_margin"]);
  const why = resolveResearchScope({ question: "Why?", companies: [NVDA], prior: fresh("How did NVDA's operating income change?", [NVDA]), asOf: AS_OF });
  assert.ok(why.inherited.includes("metrics"));
  assert.deepEqual(why.income_items, ["operating_income"]);
  // Both read back from a saved answer.
  const saved = JSON.parse(JSON.stringify(asked));
  assert.deepEqual(parseResearchScope(saved), { ...saved, inherited: [] });
});

test("a saved scope reads back; anything else starts fresh", () => {
  const saved = JSON.parse(JSON.stringify(fresh("Compare NVDA with AMD YTD", [NVDA, AMD])));
  assert.deepEqual(parseResearchScope(saved), { ...saved, inherited: [] });
  const guided = JSON.parse(JSON.stringify(fresh("What is NVDA's outlook?", [NVDA])));
  assert.deepEqual(parseResearchScope(guided), { ...guided, inherited: [] });
  for (const value of [
    null,
    "scope",
    [],
    { ...saved, peers: "yes" },
    { ...saved, fiscal_year: 2025.5 },
    { ...saved, price_window: { kind: "ytd", cutoff: "not a date" } },
    { ...saved, price_window: { kind: "1y", cutoff: AS_OF } },
    { ...saved, companies: [null] },
    { ...saved, companies: [{ issuer_id: NVDA.issuer_id, label: 7 }] },
    { ...saved, companies: "NVDA" },
  ]) {
    assert.equal(parseResearchScope(value), null, JSON.stringify(value));
  }
});


test("each metric a question names is found once, the most specific first", () => {
  const keys = (question: string) => requestedMetrics(question).map((metric) => metric.metric_key);
  assert.deepEqual(keys("What is AMD's free cash flow?"), ["free_cash_flow"]);
  assert.deepEqual(keys("Show operating cash flow and capex"), ["operating_cash_flow", "capex"]);
  assert.deepEqual(keys("What are NVDA's earnings per share?"), ["eps_diluted"]);
  assert.deepEqual(keys("NVDA earnings and EPS"), ["eps_diluted", "income_statement"]);
  assert.deepEqual(keys("Compare NVDA with AMD"), []);
  // Basic EPS is its own figure, never answered with diluted EPS.
  assert.deepEqual(keys("What was NVDA's basic EPS?"), ["eps_basic"]);
  assert.deepEqual(keys("NVDA basic earnings per share and diluted EPS"), ["eps_basic", "eps_diluted"]);
  // Cash on hand is a balance, never a cash flow.
  assert.deepEqual(keys("How much cash does NVDA have?"), ["cash_and_equivalents"]);
  assert.deepEqual(keys("NVDA cash and equivalents and its operating cash flow"), ["operating_cash_flow", "cash_and_equivalents"]);
  assert.deepEqual(keys("What is NVDA's book value?"), ["total_equity"]);
  // The whole balance sheet is its own request; an item asked beside it stays named.
  assert.deepEqual(keys("Show NVDA's balance sheet"), ["balance_sheet"]);
  assert.deepEqual(keys("How much cash is on NVDA's balance sheet?"), ["balance_sheet", "cash_and_equivalents"]);
  assert.deepEqual(keys("NVDA total assets and total liabilities"), ["total_assets", "total_liabilities"]);
});

test("a follow-up naming another metric replaces the metrics; one naming none keeps them", () => {
  const prior = fresh("What is AMD's EBITDA?", [AMD]);
  const next = (question: string) => resolveResearchScope({ question, companies: [AMD], prior, asOf: AS_OF });
  assert.equal(next("And why is that?").route, "unavailable_metric");
  assert.deepEqual(next("And why is that?").inherited, ["metrics"]);
  const revenue = next("What about its revenue?");
  assert.equal(revenue.route, "latest_quarter");
  assert.deepEqual(revenue.metrics.map((metric) => metric.metric_key), ["income_statement"]);
});

test("asking for evidence about a company the previous answer did not cover is not an evidence follow-up", () => {
  const AAPL = { issuer_id: "60000000-0000-4000-8000-000000000003", label: "AAPL" };
  const prior = fresh("Compare NVDA with AMD", [NVDA, AMD]);
  const scope = resolveResearchScope({ question: "Show the evidence for AAPL too", companies: [NVDA, AMD, AAPL], prior, asOf: AS_OF });
  assert.equal(scope.route, "comparison");
  assert.equal(fresh("Show the evidence for NVDA").route, "latest_quarter", "no previous answer to show the evidence of");
});

test("a scope saved before metrics were recorded reads back with none; a malformed metric starts fresh", () => {
  const saved = JSON.parse(JSON.stringify(fresh("Compare NVDA with AMD", [NVDA, AMD])));
  delete saved.metrics;
  delete saved.reads;
  assert.deepEqual(parseResearchScope(saved)?.metrics, []);
  assert.equal(parseResearchScope(saved)?.reads, saved.route);
  assert.equal(parseResearchScope({ ...saved, metrics: [{ metric_key: "free_cash_flow" }] }), null);
});

test("a metric's context or qualifier is not another metric", () => {
  const keys = (question: string) => requestedMetrics(question).map((metric) => metric.metric_key);
  assert.deepEqual(keys("What did AMD say about free cash flow on its earnings call?"), ["free_cash_flow"]);
  // A qualified statement metric is its own named gap, never the plain figure.
  assert.deepEqual(requestedMetrics("What is AMD's free cash flow growth?"), [
    { metric_key: "free_cash_flow_growth", label: "Free cash flow growth", available: false },
  ]);
  assert.equal(fresh("What is AMD's free cash flow growth?", [AMD]).route, "unavailable_metric");
  assert.deepEqual(keys("Show NVDA's EPS growth over the last 4 quarters"), ["eps_diluted_growth"]);
  // The qualifier before the metric too, with nothing else asked for in its place.
  assert.deepEqual(keys("Show the growth in free cash flow"), ["free_cash_flow_growth"]);
  assert.deepEqual(keys("What was the growth in NVDA's EPS?"), ["eps_diluted_growth"]);
  assert.deepEqual(keys("AMD trend of its operating cash flow"), ["operating_cash_flow_trend"]);
  assert.equal(fresh("Show the growth in free cash flow", [AMD]).route, "unavailable_metric");
  assert.deepEqual(keys("What is NVDA's free cash flow per share?"), ["free_cash_flow_per_share"]);
  assert.deepEqual(keys("What is AMD's EBITDA growth?"), ["ebitda"]);
  assert.equal(fresh("What is AMD's EBITDA growth?", [AMD]).route, "unavailable_metric");
  assert.deepEqual(keys("What is its profitability?"), ["income_statement"]);
});

test("an inherited gap, or one asked beside something it can show, does not stop the turn reading", () => {
  const prior = fresh("What is AMD's free cash flow?", [AMD]);
  const next = (question: string, companies: ResearchScope["companies"]) =>
    resolveResearchScope({ question, companies, prior, asOf: AS_OF });
  const ytd = next("Also compare its YTD stock performance with NVDA", [AMD, NVDA]);
  assert.equal(ytd.route, "comparison");
  // The gap stays named.
  assert.deepEqual(ytd.metrics.map((metric) => metric.metric_key), ["free_cash_flow"]);
  assert.equal(next("What is its profitability?", [AMD]).route, "derived_margin");
  assert.equal(fresh("What is AMD's free cash flow YTD versus NVDA?", [AMD, NVDA]).route, "comparison");
});

test("an evidence follow-up re-reads what the previous answer read", () => {
  const prior = fresh("Break down AMD's revenue by segment", [AMD]);
  const scope = resolveResearchScope({ question: "Show the evidence", companies: [AMD], prior, asOf: AS_OF });
  assert.equal(scope.route, "evidence_followup");
  assert.equal(scope.reads, "segments");
  const gapPrior = fresh("What is AMD's EBITDA?", [AMD]);
  assert.equal(resolveResearchScope({ question: "Show the evidence", companies: [AMD], prior: gapPrior, asOf: AS_OF }).reads, "unavailable_metric");
  const statementPrior = fresh("What is AMD's free cash flow?", [AMD]);
  assert.equal(resolveResearchScope({ question: "Show the evidence", companies: [AMD], prior: statementPrior, asOf: AS_OF }).reads, "statements");
});

test("metrics the financial engine served are not gaps", () => {
  const scope = resolveResearchScope({ question: "What was NVDA's EPS?", companies: [NVDA], prior: null, asOf: AS_OF, served: true });
  assert.deepEqual(scope.metrics.map((metric) => metric.available), [true]);
  assert.equal(scope.reads, "financial_answer");
  // A follow-up asking for its evidence re-reads that answer: neither a gap nor
  // another reader's figures in its place.
  const evidence = resolveResearchScope({ question: "Show the evidence", companies: [NVDA], prior: scope, asOf: AS_OF });
  assert.equal(evidence.reads, "financial_answer");
  // Any other follow-up reads its own route.
  assert.equal(resolveResearchScope({ question: "Compare it with AMD", companies: [NVDA, AMD], prior: scope, asOf: AS_OF }).reads, "comparison");
});

test("an evidence follow-up about one compared company re-reads the whole comparison", () => {
  const prior = fresh("Compare NVDA with AMD", [NVDA, AMD]);
  const scope = resolveResearchScope({ question: "Show the evidence for NVDA", companies: [NVDA], prior, asOf: AS_OF });
  assert.equal(scope.route, "evidence_followup");
  assert.equal(scope.reads, "comparison");
  assert.deepEqual(scope.companies, [NVDA, AMD]);
});

test("a company's sources of revenue are not a request for evidence", () => {
  const prior = fresh("Analyze NVDA");
  const ask = (question: string) => resolveResearchScope({ question, companies: [NVDA], prior, asOf: AS_OF }).route;
  assert.notEqual(ask("What are NVDA's revenue sources?"), "evidence_followup");
  assert.equal(ask("What are your sources?"), "evidence_followup");
  assert.equal(ask("Show the sources for this"), "evidence_followup");
  assert.equal(ask("What is your source?"), "evidence_followup");
  assert.equal(ask("Show the source for this"), "evidence_followup");
  assert.notEqual(ask("What are the sources of NVDA's revenue?"), "evidence_followup");
});

test("a named metric's margin is part of that metric, not a margin question", () => {
  assert.equal(fresh("What is AMD's EBITDA margin?", [AMD]).route, "unavailable_metric");
  assert.equal(fresh("What is AMD's EBITDA margin trend?", [AMD]).margin_trend, false);
  assert.equal(fresh("What is AMD's EBITDA and gross margin?", [AMD]).route, "derived_margin");
  assert.equal(fresh("What is AMD's free cash flow margin?", [AMD]).route, "unavailable_metric");
  assert.equal(fresh("What is AMD's free cash flow margin trend?", [AMD]).margin_trend, false);
  assert.equal(fresh("What is AMD's free cash flow and gross margin?", [AMD]).route, "derived_margin");
});

test("a cash flow category named after 'cash flow from' is that category, never operating cash flow", () => {
  const keys = (question: string) => requestedMetrics(question).map((metric) => metric.metric_key);
  assert.deepEqual(keys("What was AMD's cash flow from investing activities?"), ["investing_cash_flow"]);
  assert.deepEqual(keys("Show AMD's cash flows used in financing activities"), ["financing_cash_flow"]);
  assert.equal(fresh("What was AMD's cash flow from investing activities?", [AMD]).route, "unavailable_metric");
  // Cash flow from operations is operating cash flow.
  assert.deepEqual(keys("What was AMD's cash flow from operations?"), ["operating_cash_flow"]);
});

test("an adjusted or non-GAAP figure is a named gap, never the GAAP figure in its place", () => {
  const metrics = (question: string) => requestedMetrics(question).map((metric) => [metric.metric_key, metric.label, metric.available]);
  assert.deepEqual(metrics("What was NVDA's adjusted EPS?"), [["eps_diluted_adjusted", "Adjusted earnings per share", false]]);
  assert.deepEqual(metrics("NVDA non-GAAP EPS"), [["eps_diluted_non_gaap", "Non-GAAP earnings per share", false]]);
  // The explicit "diluted" form too.
  assert.deepEqual(metrics("What was NVDA's adjusted diluted EPS?"), [["eps_diluted_adjusted", "Adjusted earnings per share", false]]);
  assert.deepEqual(metrics("NVDA non-GAAP diluted earnings per share"), [["eps_diluted_non_gaap", "Non-GAAP earnings per share", false]]);
  assert.deepEqual(metrics("NVDA diluted EPS"), [["eps_diluted", "Earnings per share", true]]);
  assert.deepEqual(metrics("What is NVDA's adjusted free cash flow?"), [["free_cash_flow_adjusted", "Adjusted free cash flow", false]]);
  assert.deepEqual(metrics("What was NVDA's non-GAAP operating income?"), [["non_gaap_income", "Non-GAAP earnings", false]]);
  assert.deepEqual(metrics("NVDA adjusted net income"), [["non_gaap_income", "Non-GAAP earnings", false]]);
  for (const question of ["What was NVDA's adjusted EPS?", "What was NVDA's non-GAAP operating income?"]) {
    assert.equal(fresh(question, [NVDA]).route, "unavailable_metric", question);
  }
  // Unqualified, they are the reported figures.
  assert.deepEqual(metrics("What was NVDA's EPS?"), [["eps_diluted", "Earnings per share", true]]);
  // Each mention is classified, so a reported figure asked beside its adjusted
  // or qualified form keeps the gap for the other.
  assert.deepEqual(metrics("Show NVDA's EPS and adjusted EPS"), [
    ["eps_diluted", "Earnings per share", true],
    ["eps_diluted_adjusted", "Adjusted earnings per share", false],
  ]);
  assert.deepEqual(metrics("NVDA free cash flow and free cash flow margin").map(([key]) => key), ["free_cash_flow", "free_cash_flow_margin"]);
  assert.deepEqual(metrics("NVDA EPS and EPS").map(([key]) => key), ["eps_diluted"]);
});

test("a cash-flow category is that category; unqualified cash flow is operating", () => {
  const keys = (question: string) => requestedMetrics(question).map((metric) => metric.metric_key);
  assert.deepEqual(keys("What was AMD's financing cash flow?"), ["financing_cash_flow"]);
  assert.deepEqual(keys("And its investing cash flow?"), ["investing_cash_flow"]);
  assert.deepEqual(keys("What is AMD's cash flow?"), ["operating_cash_flow"]);
});

test("segments asked with any margin record the margin, so both are read", () => {
  const scope = fresh("Break down AMD's revenue by segment and show its gross margin", [AMD]);
  assert.equal(scope.reads, "segments");
  assert.equal(scope.margins, true);
  const prior = fresh("Break down AMD's revenue by segment", [AMD]);
  assert.equal(prior.margins, false);
  // An inherited segment facet with a margin asked now.
  assert.equal(resolveResearchScope({ question: "What is its gross margin?", companies: [AMD], prior, asOf: AS_OF }).margins, true);
});

test("a statement metric asked year to date is a named gap, never the latest quarter in its place", () => {
  for (const question of ["What is NVDA's free cash flow YTD?", "Show NVDA's year-to-date EPS"]) {
    const scope = fresh(question, [NVDA]);
    assert.equal(scope.route, "unavailable_metric", question);
    assert.deepEqual(scope.metrics.map((metric) => metric.available), [false], question);
  }
  assert.deepEqual(fresh("What is NVDA's free cash flow YTD?", [NVDA]).metrics, [
    { metric_key: "free_cash_flow_ytd", label: "Free cash flow year to date", available: false },
  ]);
  // A comparison charts the window; its statement metrics are already one company at a time.
  assert.equal(fresh("Compare NVDA and AMD free cash flow YTD", [NVDA, AMD]).route, "comparison");
  // A YTD that qualifies something else leaves the statement metric as asked.
  const eps = fresh("Show NVDA EPS and YTD stock return", [NVDA]);
  assert.deepEqual(eps.metrics.map((metric) => [metric.metric_key, metric.available]), [["eps_diluted", true]]);
  assert.equal(eps.route, "statements");
});

test("a single company's YTD gap stays a gap: its answer has no price chart", () => {
  assert.equal(fresh("What was AMD's EBITDA YTD?", [AMD]).route, "unavailable_metric");
  // A comparison does chart the window, so it is read beside the gap.
  assert.equal(fresh("What is AMD's EBITDA YTD versus NVDA?", [AMD, NVDA]).route, "comparison");
});

// #206: a follow-up can turn a facet off; it then stays off.
test("dropping the cash flow drops every cash flow figure", () => {
  const prior = fresh("Show NVDA's free cash flow, capex and balance sheet", [NVDA]);
  const next = resolveResearchScope({ question: "Drop the cash flow", companies: [NVDA], prior, asOf: AS_OF });
  assert.deepEqual(next.metrics.map((metric) => metric.metric_key), ["balance_sheet"]);
  assert.equal(next.route, "statements");
});

test("dropping operating cash flow by name keeps the other cash flow figures", () => {
  const prior = fresh("Show NVDA's operating cash flow and capex", [NVDA]);
  const next = resolveResearchScope({ question: "Drop operating cash flow", companies: [NVDA], prior, asOf: AS_OF });
  assert.deepEqual(next.metrics.map((metric) => metric.metric_key), ["capex"]);
  // Each clause is read on its own: a later clause does not widen an earlier one.
  const more = fresh("Show NVDA's operating cash flow, capex, free cash flow and EPS", [NVDA]);
  const both = resolveResearchScope({ question: "Drop operating cash flow; drop EPS", companies: [NVDA], prior: more, asOf: AS_OF });
  assert.deepEqual(both.metrics.map((metric) => metric.metric_key), ["free_cash_flow", "capex"]);
});

test("cash from operations and cash equivalents are the statement figures they name", () => {
  const keys = (question: string) => requestedMetrics(question).map((metric) => metric.metric_key);
  for (const question of [
    "What was NVDA's cash from operations?",
    "NVDA cash provided by operating activities",
    "How much cash was generated from operations?",
    // A negative operating cash flow is reported as cash used.
    "What was AMD's net cash used in operating activities?",
    "AMD cash used for operations",
    // The statement's own label.
    "What was AMD's net cash provided by (used in) operating activities?",
  ]) {
    assert.deepEqual(keys(question), ["operating_cash_flow"], question);
  }
  assert.deepEqual(keys("What was AMD's cash used in investing activities?"), ["investing_cash_flow"]);
  assert.deepEqual(keys("AMD cash provided by financing activities"), ["financing_cash_flow"]);
  assert.deepEqual(keys("AMD cash used for investing activities"), ["investing_cash_flow"]);
  assert.deepEqual(keys("AMD cash flows used for financing activities"), ["financing_cash_flow"]);
  // One phrasing for all three categories, so none drifts from the others.
  for (const [activity, key] of [["operating", "operating_cash_flow"], ["investing", "investing_cash_flow"], ["financing", "financing_cash_flow"]] as const) {
    for (const verb of ["from", "provided by", "used in", "used for", "provided by (used in)", "used in (provided by)"]) {
      assert.deepEqual(keys(`AMD net cash ${verb} ${activity} activities`), [key], `${verb} ${activity}`);
    }
  }
  assert.deepEqual(keys("What are NVDA's cash equivalents?"), ["cash_and_equivalents"]);
  assert.equal(fresh("What was NVDA's cash from operations?", [NVDA]).route, "statements");
});

test("dropping the balance sheet drops its items, however they were kept", () => {
  const ask = (question: string, prior: ResearchScope | null) =>
    resolveResearchScope({ question, companies: [NVDA], prior, asOf: AS_OF });
  const balance = ask("Show NVDA's balance sheet and EPS", null);
  const withoutAssets = ask("Drop total assets", balance);
  assert.deepEqual(withoutAssets.metrics.map((metric) => metric.metric_key), ["cash_and_equivalents", "total_liabilities", "total_equity", "eps_diluted"]);
  const withoutBalance = ask("Drop the balance sheet", withoutAssets);
  assert.deepEqual(withoutBalance.metrics.map((metric) => metric.metric_key), ["eps_diluted"]);
});

test("a follow-up that turns a facet off clears it; the rest is kept", () => {
  const prior = fresh("Compare NVDA with AMD segments, margin trends and free cash flow, fiscal 2025, YTD", [NVDA, AMD]);
  const next = (question: string) =>
    resolveResearchScope({ question, companies: [NVDA, AMD], prior, asOf: "2026-09-02T00:00:00.000Z" });

  const noSegments = next("Same again without segments");
  assert.equal(noSegments.segments, false);
  assert.equal(noSegments.margin_trend, true);
  assert.equal(noSegments.fiscal_year, 2025);
  assert.ok(!noSegments.inherited.includes("segments"));

  const noWindow = next("Drop the YTD window");
  assert.equal(noWindow.price_window, null);
  assert.ok(!noWindow.inherited.includes("price_window"));
  assert.equal(noWindow.segments, true);

  const noMargins = next("Remove the margins");
  assert.equal(noMargins.margin_trend, false);
  assert.equal(noMargins.margins, false);

  const noYear = next("Forget fiscal 2025");
  assert.equal(noYear.fiscal_year, null);

  assert.deepEqual(next("Leave out free cash flow").metrics.map((metric) => metric.metric_key), ["income_statement"]);

  // Turned off, it stays off on the turn after.
  const after = resolveResearchScope({ question: "And now?", companies: [NVDA, AMD], prior: noSegments, asOf: "2026-09-03T00:00:00.000Z" });
  assert.equal(after.segments, false);
});

test("a facet turned off is not also asked for", () => {
  const prior = fresh("Break down NVDA's revenue by segment", [NVDA]);
  const next = resolveResearchScope({ question: "Show NVDA without the segments", companies: [NVDA], prior, asOf: AS_OF });
  assert.equal(next.segments, false);
  assert.equal(next.route, "latest_quarter");
});

test("a benchmark is a named gap the next turns keep until it is turned off", () => {
  const first = fresh("Compare NVDA and AMD YTD against the S&P 500", [NVDA, AMD]);
  assert.equal(first.benchmark, true);
  // The comparison is still read; only the benchmark is missing.
  assert.equal(first.route, "comparison");
  const table = resolveResearchScope({ question: "Show it as a table", companies: [NVDA, AMD], prior: first, asOf: AS_OF });
  assert.equal(table.benchmark, true);
  assert.ok(table.inherited.includes("benchmark"));
  const off = resolveResearchScope({ question: "Drop the benchmark", companies: [NVDA, AMD], prior: table, asOf: AS_OF });
  assert.equal(off.benchmark, false);
  assert.equal(fresh("Analyze NVDA").benchmark, false);
  // Saved before benchmarks were recorded: none.
  const { benchmark: _benchmark, ...old } = JSON.parse(JSON.stringify(first));
  assert.equal(parseResearchScope(old)?.benchmark, false);
  assert.equal(parseResearchScope(JSON.parse(JSON.stringify(first)))?.benchmark, true);
});

test("a follow-up turns off every facet in a list, and stops at the next request", () => {
  const prior = fresh("Compare NVDA with AMD segments and margin trends YTD against the S&P 500", [NVDA, AMD]);
  const next = (question: string) =>
    resolveResearchScope({ question, companies: [NVDA, AMD], prior, asOf: "2026-09-02T00:00:00.000Z" });
  const both = next("Same, without segments and margins");
  assert.equal(both.segments, false);
  assert.equal(both.margin_trend, false);
  const listed = next("Drop the benchmark, the segments and the YTD window");
  assert.equal(listed.benchmark, false);
  assert.equal(listed.segments, false);
  assert.equal(listed.price_window, null);
  // "and show ..." asks for something else: segments stay off, margins stay on.
  const then = next("Drop the segments and show the margin trend");
  assert.equal(then.segments, false);
  assert.equal(then.margin_trend, true);
});

test("'no' turns a facet off only at the start of a clause", () => {
  const prior = fresh("Compare NVDA with AMD segments and margin trends", [NVDA, AMD]);
  const next = (question: string) =>
    resolveResearchScope({ question, companies: [NVDA, AMD], prior, asOf: "2026-09-02T00:00:00.000Z" });
  assert.equal(next("Why was there no change in margins over the last year?").margin_trend, true);
  assert.equal(next("No segments this time").segments, false);
  assert.equal(next("Same table, no segments").segments, false);
  assert.equal(next("Keep the margins and no segments").segments, false);
});
