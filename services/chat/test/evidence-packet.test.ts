import test from "node:test";
import assert from "node:assert/strict";

import { buildEvidencePacket, claimSelection, packetForModel, type ClaimRecord } from "../src/evidence-packet.ts";
import { resolveResearchScope } from "../src/research-scope.ts";

const NVDA = { issuer_id: "60000000-0000-4000-8000-000000000001", label: "NVDA" };
const AMD = { issuer_id: "60000000-0000-4000-8000-000000000002", label: "AMD" };
const AAPL = { issuer_id: "60000000-0000-4000-8000-000000000003", label: "AAPL" };
const CUTOFF = "2026-09-01T00:00:00.000Z";
const scope = (question: string, companies = [NVDA]) =>
  resolveResearchScope({ question, companies, prior: null, asOf: CUTOFF });

const LATEST = {
  id: "b-latest",
  kind: "metric_row",
  title: "Latest quarter (Q4 2026)",
  source_refs: ["s-10q"],
  items: [
    { label: "Revenue", format: "$62.1B", value_ref: "f-rev" },
    { label: "Gross margin", format: "74.4%", value_ref: "f-gm" },
  ],
};
const BARS = {
  id: "b-bars",
  kind: "revenue_bars",
  title: "Quarterly revenue",
  source_refs: ["s-10q", "s-10k"],
  bars: [{ label: "Q3 2026", format: "$57.0B", value_ref: "f-q3" }, { label: "Q4 2026", format: "$62.1B", value_ref: "f-rev" }],
};

test("a quarterly packet holds only its figures, each with a packet id, its fact, sources and format (#207)", () => {
  const packet = buildEvidencePacket({ scope: scope("Analyze NVDA's latest quarter"), factBlocks: [LATEST, BARS], cutoff: CUTOFF });
  assert.equal(packet.route, "latest_quarter");
  assert.equal(packet.cutoff, CUTOFF);
  assert.deepEqual(packet.figures.map((figure) => [figure.id, figure.metric, figure.period ?? null, figure.value, figure.fact_id, figure.source_ids]), [
    ["F1", "Revenue", null, "$62.1B", "f-rev", ["s-10q"]],
    ["F2", "Gross margin", null, "74.4%", "f-gm", ["s-10q"]],
    ["F3", "Revenue", "Q3 2026", "$57.0B", "f-q3", ["s-10q", "s-10k"]],
    ["F4", "Revenue", "Q4 2026", "$62.1B", "f-rev", ["s-10q", "s-10k"]],
  ]);
  assert.deepEqual(packet.coverage, [{ company: "NVDA", status: "shown" }]);
  assert.deepEqual(packet.query_bounds, { periods: "latest quarter, with revenue for the last 8 quarters" });
});

test("a comparison packet binds each figure to its company and period; a company with none is a named gap (#207)", () => {
  const comparison = {
    id: "b-cmp",
    kind: "metrics_comparison",
    title: "Side by side (fiscal 2025)",
    subject_labels: ["NVDA", "AMD"],
    metrics: ["Revenue"],
    source_refs: ["s-nvda", "s-amd"],
    cells: [[{ value_ref: "f-n", format: "$130.5B" }], [{ value_ref: "f-a", format: "$25.8B" }]],
    data_ref: { params: { fact_bindings: [
      { fact_id: "f-n", fiscal_year: 2025, fiscal_period: "FY", period_end: "2025-01-26" },
      { fact_id: "f-a", fiscal_year: 2025, fiscal_period: "FY", period_end: "2025-12-27" },
    ] } },
  };
  const packet = buildEvidencePacket({
    scope: scope("Compare NVDA, AMD and AAPL fiscal 2025 revenue", [NVDA, AMD, AAPL]),
    factBlocks: [comparison],
    cutoff: CUTOFF,
  });
  assert.deepEqual(packet.figures.map((figure) => [figure.company, figure.period, figure.period_end, figure.fact_id]), [
    ["NVDA", "FY2025", "2025-01-26", "f-n"],
    ["AMD", "FY2025", "2025-12-27", "f-a"],
  ]);
  assert.deepEqual(packet.coverage, [
    { company: "NVDA", status: "shown" },
    { company: "AMD", status: "shown" },
    { company: "AAPL", status: "not_shown" },
  ]);
  assert.deepEqual(packet.query_bounds, { periods: "fiscal year 2025 per company" });
});

test("a metric no reader serves is a gap with no figure in its place (#207)", () => {
  const gap = { id: "b-gap", kind: "rich_text", segments: [{ type: "text", text: "EBITDA is not available for AMD in this data, so no other figure is shown in its place." }] };
  const packet = buildEvidencePacket({ scope: scope("What is AMD's EBITDA?", [AMD]), factBlocks: [gap], cutoff: CUTOFF });
  assert.equal(packet.route, "unavailable_metric");
  assert.deepEqual(packet.figures, []);
  assert.deepEqual(packet.gaps, [gap.segments[0]!.text]);
  assert.deepEqual(packet.coverage, [{ company: "AMD", status: "not_shown" }]);
  assert.deepEqual(packet.query_bounds, {});
});

test("a cash flow question names the periods its readers cover", () => {
  const packet = buildEvidencePacket({ scope: scope("What is AMD's free cash flow?", [AMD]), factBlocks: [], cutoff: CUTOFF });
  assert.equal(packet.route, "statements");
  assert.equal(
    packet.query_bounds.periods,
    "latest quarter and latest fiscal year reported for cash flow; balance sheet at its latest period end; EPS for the latest quarter, or the fiscal year once its annual report is in",
  );
  // A named fiscal year is the only period read.
  const year = buildEvidencePacket({ scope: scope("What was AMD's free cash flow in fiscal 2024?", [AMD]), factBlocks: [], cutoff: CUTOFF });
  assert.equal(
    year.query_bounds.periods,
    "fiscal year 2024 only: its latest quarter and the year for cash flow; balance sheet at its latest period end in that year; EPS for that year",
  );
});

test("an inherited YTD window is bounded at its own cutoff (#207)", () => {
  const first = scope("Compare NVDA with AMD YTD", [NVDA, AMD]);
  const next = resolveResearchScope({ question: "Explain the differences", companies: [NVDA, AMD], prior: first, asOf: "2026-09-05T00:00:00.000Z" });
  const packet = buildEvidencePacket({ scope: next, factBlocks: [], cutoff: "2026-09-05T00:00:00.000Z" });
  assert.equal(packet.query_bounds.price_window, "year to date, to the 2026-09-01 cutoff");
});

test("the model's packet has short ids only, no fact or source ids (#207)", () => {
  const model = JSON.stringify(packetForModel(buildEvidencePacket({ scope: scope("Analyze NVDA"), factBlocks: [LATEST], cutoff: CUTOFF })));
  assert.match(model, /"id":"F1"/);
  for (const absent of ["fact_id", "f-rev", "source_ids", "s-10q", "block_id", "b-latest"]) assert.ok(!model.includes(absent), absent);
});

test("an auto-selected peer with no block is still covered, as not shown (#207)", () => {
  // A peers request's auto-selected peer carries no label, and the comparison
  // and price readers came back empty.
  const peers = { ...scope("How does NVDA compare with its peers?"), companies: [NVDA, { issuer_id: AMD.issuer_id }] };
  const packet = buildEvidencePacket({ scope: peers, factBlocks: [], cutoff: CUTOFF });
  assert.deepEqual(packet.coverage, [
    { company: "NVDA", status: "not_shown" },
    { company: "issuer:60000000", status: "not_shown" },
  ]);
});

test("a single company's figures carry the period and end date their facts are bound to (#207)", () => {
  const bound = (block: Record<string, unknown>, bindings: unknown[]) => ({ ...block, data_ref: { params: { fact_bindings: bindings } } });
  const packet = buildEvidencePacket({
    scope: scope("Analyze NVDA's latest quarter"),
    factBlocks: [
      bound(LATEST, [
        { fact_id: "f-rev", fiscal_year: 2026, fiscal_period: "Q4", period_end: "2026-01-25" },
        { fact_id: "f-gm", fiscal_year: 2026, fiscal_period: "Q4", period_end: "2026-01-25" },
      ]),
      bound(BARS, [{ fact_id: "f-q3", fiscal_year: 2026, fiscal_period: "Q3", period_end: "2025-10-26" }]),
    ],
    cutoff: CUTOFF,
  });
  assert.deepEqual(packet.figures.map((figure) => [figure.id, figure.period ?? null, figure.period_end ?? null]), [
    ["F1", "Q42026", "2026-01-25"],
    ["F2", "Q42026", "2026-01-25"],
    // A bar keeps its quarter label and gains the end date of the fact it cites.
    ["F3", "Q3 2026", "2025-10-26"],
    ["F4", "Q4 2026", null],
  ]);
});

const claim = (id: string, overrides: Partial<ClaimRecord>): ClaimRecord => ({
  claim_id: id,
  source_id: `s-${id}`,
  text_canonical: `Claim ${id}.`,
  predicate: "guidance.change",
  polarity: "neutral",
  effective_time: "2026-05-01T00:00:00.000Z",
  published_at: "2026-05-02T00:00:00.000Z",
  subject_id: NVDA.issuer_id,
  ...overrides,
});

test("a route reads its predicate families first, from the start of the period it covers (#207)", () => {
  // Management's own explanations come first on every route: they are the only
  // causes an answer may state.
  assert.deepEqual(claimSelection(scope("Analyze NVDA's latest quarter"), CUTOFF), {
    predicate_prefixes: ["management.", "guidance.", "kpi."],
    effective_from: "2024-09-01T00:00:00.000Z",
    effective_until: null,
    fiscal_year: null,
  });
  assert.deepEqual(claimSelection(scope("Break down NVDA's segments"), CUTOFF).predicate_prefixes, ["management.", "segment.", "guidance."]);
  // Management's explanation of what the question asks about comes before its
  // other explanations: one release can hold more than the claim limit.
  assert.deepEqual(claimSelection(scope("What changed in NVDA's gross margin in Q1 fiscal 2026?"), CUTOFF).predicate_prefixes, [
    "management.explanation.gross_margin",
    "management.explanation.operating_income",
    "management.explanation.net_income",
    "management.",
    "guidance.",
    "kpi.",
  ]);
  assert.deepEqual(claimSelection(scope("What is NVDA's free cash flow?"), CUTOFF).predicate_prefixes.slice(0, 4), [
    "management.explanation.free_cash_flow",
    "management.explanation.operating_cash_flow",
    "management.explanation.capex",
    "management.",
  ]);
  assert.equal(claimSelection(scope("What was NVDA's EPS?"), CUTOFF).predicate_prefixes[0], "management.explanation.eps");
  // Operating or net income is read as the income statement: its explanations
  // share one priority, so revenue's never crowd out the one named.
  assert.deepEqual(claimSelection(scope("Why did NVDA's operating income fall?"), CUTOFF).predicate_prefixes.slice(0, 2), [
    ["management.explanation.revenue", "management.explanation.operating_income", "management.explanation.net_income"],
    "management.",
  ]);
  for (const question of ["How have NVDA's margins trended?", "What is NVDA's free cash flow?", "Compare NVDA with AMD"]) {
    assert.ok(claimSelection(scope(question, question.includes("AMD") ? [NVDA, AMD] : [NVDA]), CUTOFF).predicate_prefixes.flat()[0]!.startsWith("management."), question);
  }
  // A fiscal year's window ends a quarter after the year, when its last release is out.
  const fiscal = claimSelection(scope("Compare NVDA with AMD for fiscal year 2025", [NVDA, AMD]), CUTOFF);
  assert.equal(fiscal.effective_from, "2024-01-01T00:00:00.000Z");
  assert.equal(fiscal.effective_until, "2026-04-01T00:00:00.000Z");
  // The issuer's own fiscal year bounds it where its facts date that year.
  assert.equal(fiscal.fiscal_year, 2025);
  assert.equal(claimSelection(scope("What changed in NVDA's gross margin in Q1 fiscal 2026?"), CUTOFF).effective_until, "2027-04-01T00:00:00.000Z");
  assert.deepEqual(claimSelection(undefined, CUTOFF), { predicate_prefixes: [], effective_from: null, effective_until: null, fiscal_year: null });
});

test("claims carry short ids, their company and a stance only their stored polarity gives (#207)", () => {
  const packet = buildEvidencePacket({
    scope: scope("Compare NVDA with AMD", [NVDA, AMD]),
    factBlocks: [],
    cutoff: CUTOFF,
    claims: {
      claims: [
        claim("a", { polarity: "positive" }),
        claim("b", { polarity: "negative", subject_id: AMD.issuer_id }),
        claim("c", { polarity: "mixed" }),
        claim("d", { polarity: "neutral", subject_id: undefined }),
      ],
      truncated: true,
    },
  });
  assert.deepEqual(packet.claims.map((entry) => [entry.id, entry.company ?? null, entry.stance, entry.claim_id]), [
    ["C1", "NVDA", "supporting", "a"],
    ["C2", "AMD", "challenging", "b"],
    ["C3", "NVDA", "unclassified", "c"],
    ["C4", null, "neutral", "d"],
  ]);
  assert.equal(packet.claims_truncated, true);
  assert.match(packet.query_bounds.claims!, /^management, guidance, and kpi claims from 2024-09-01 first, then the most recent others, published by the 2026-09-01 cutoff/);
  const forModel = packetForModel(packet);
  assert.equal(JSON.stringify(forModel).includes("s-a"), false, "no source ids reach the model");
  assert.equal(JSON.stringify(forModel).includes("\"claim_id\""), false, "no claim ids reach the model");
  assert.equal(forModel.claims_truncated, true);
});

test("only a stored contradiction is a disagreement; opposite directions, tone or another company are not (#207)", () => {
  const packet = buildEvidencePacket({
    factBlocks: [],
    cutoff: CUTOFF,
    claims: {
      claims: [
        // Raised revenue guidance and lowered EPS guidance can both be true.
        claim("raised-revenue", { polarity: "positive" }),
        claim("lowered-eps", { polarity: "negative", effective_time: "2026-06-15T00:00:00.000Z" }),
        claim("amd-lowered", { polarity: "negative", subject_id: AMD.issuer_id }),
        claim("upbeat", { predicate: "management.tone", polarity: "positive" }),
        claim("downbeat", { predicate: "management.tone", polarity: "negative" }),
        claim("backlog-up", { predicate: "kpi.commentary", polarity: "positive", effective_time: "2025-01-01T00:00:00.000Z" }),
        claim("backlog-down", { predicate: "kpi.commentary", polarity: "negative", effective_time: "2026-01-01T00:00:00.000Z" }),
      ],
      contradictions: [["backlog-up", "backlog-down"], ["backlog-up", "not-selected"]],
    },
  });
  assert.deepEqual(packet.disagreements, [
    { claims: ["C6", "C7"], basis: "a stored relation marks them as contradicting" },
  ]);
});

test("a failed claims read is unavailable, never none on file, and names nothing (#207)", () => {
  const packet = buildEvidencePacket({ factBlocks: [], cutoff: CUTOFF, claims: { claims: [], unavailable: true } });
  assert.equal(packet.claims_status, "unavailable");
  assert.deepEqual(packetForModel(packet), { route: "unknown", cutoff: CUTOFF, figures: [], query_bounds: packet.query_bounds, claims_status: "unavailable" });
  assert.equal(buildEvidencePacket({ factBlocks: [], cutoff: CUTOFF, claims: { claims: [] } }).claims_status, "none");
});

test("a stored contradiction listed in either order is one disagreement (#207)", () => {
  const packet = buildEvidencePacket({
    factBlocks: [],
    cutoff: CUTOFF,
    claims: {
      claims: [claim("raised", { polarity: "positive" }), claim("lowered", { polarity: "negative" })],
      contradictions: [["lowered", "raised"]],
    },
  });
  assert.deepEqual(packet.disagreements, [{ claims: ["C1", "C2"], basis: "a stored relation marks them as contradicting" }]);
});

test("a price window adds its event predicates to the route's, over the route's period (#207)", () => {
  const ytd = scope("Compare NVDA with AMD YTD", [NVDA, AMD]);
  assert.equal(ytd.reads, "comparison");
  assert.deepEqual(claimSelection(ytd, CUTOFF), {
    predicate_prefixes: ["management.", "guidance.", "kpi.", "material_event."],
    effective_from: "2024-09-01T00:00:00.000Z",
    effective_until: null,
    fiscal_year: null,
  });
});

test("an auto-selected peer's claims name it as coverage does, even with no figures (#207)", () => {
  const peer = "60000000-0000-4000-8000-0000000000ff";
  const base = scope("Compare NVDA with its peers");
  const packet = buildEvidencePacket({
    scope: { ...base, companies: [NVDA, { issuer_id: peer }] },
    factBlocks: [],
    cutoff: CUTOFF,
    claims: { claims: [claim("p", { subject_id: peer })] },
  });
  assert.ok(packet.coverage.some((entry) => entry.company === "issuer:60000000"));
  assert.equal(packet.claims[0]!.company, "issuer:60000000");
});
