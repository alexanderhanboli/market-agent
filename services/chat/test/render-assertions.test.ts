import test from "node:test";
import assert from "node:assert/strict";

import { calendarsDiffer, plainText, renderAssertion } from "../src/render-assertions.ts";
import type { Assertion } from "../src/assertions.ts";
import type { EvidencePacket } from "../src/evidence-packet.ts";

const NVDA_GM = "a1000000-0000-4000-8000-000000000001";
const AMD_GM = "a1000000-0000-4000-8000-000000000002";
const CLAIM = "c1000000-0000-4000-8000-000000000001";
const BINDING = (fact_id: string) => ({ fact_id, unit: "ratio", period_kind: "fiscal_y", fiscal_year: 2026, fiscal_period: "FY", period_end: "2026-01-25", as_of: "2026-02-26T00:00:00.000Z", source_id: "s" });
const FACT_BLOCKS = [{ id: "b1", kind: "metrics_comparison", data_ref: { kind: "metrics_comparison", id: "b1", params: { fact_bindings: [BINDING(NVDA_GM), BINDING(AMD_GM)] } } }];

const PACKET: EvidencePacket = {
  route: "comparison",
  cutoff: "2026-09-01T00:00:00.000Z",
  companies: ["NVDA", "AMD"],
  figures: [
    { id: "F1", company: "NVDA", metric: "Gross margin", period: "FY2026", value: "74.6%", fact_id: NVDA_GM, source_ids: ["s-nvda"] },
    { id: "F2", company: "AMD", metric: "Gross margin", period: "FY2025", value: "49.2%", fact_id: AMD_GM, source_ids: ["s-amd"] },
    { id: "F3", company: "AMD", metric: "EPS", value: "$1.37", fact_id: "not-a-uuid", source_ids: [] },
  ],
  coverage: [],
  gaps: [],
  query_bounds: {},
  claims: [{ id: "C1", text: "Management cited a richer data-center mix.", predicate: "kpi.commentary", stance: "supporting", company: "NVDA", effective_time: "2026-02-25T00:00:00.000Z", claim_id: CLAIM, source_id: "s-claim" }],
  disagreements: [],
  claims_status: "available",
  claims_truncated: false,
};

test("an observation is rendered from its figures, each value a sealed fact ref (#208)", () => {
  const rendered = renderAssertion({ index: 0, kind: "observation", text: "ignored", evidence: ["F1", "F2"] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(rendered.segments), "NVDA's gross margin was 74.6% in FY2026; AMD's gross margin was 49.2% in FY2025.");
  assert.deepEqual(rendered.segments.filter((segment) => segment.type === "ref"), [
    { type: "ref", ref_kind: "fact", ref_id: NVDA_GM, format: "74.6%" },
    { type: "ref", ref_kind: "fact", ref_id: AMD_GM, format: "49.2%" },
  ]);
  assert.deepEqual(rendered.fact_bindings.map((binding) => binding.fact_id), [NVDA_GM, AMD_GM]);
  assert.deepEqual(rendered.source_refs, ["s-nvda", "s-amd"]);
});

test("a value whose fact cannot seal here is the packet's value in plain text; the guard reads it as its reference (#208, #301)", () => {
  const rendered = renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F3"] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(rendered.segments), "AMD's EPS was $1.37.");
  assert.equal(rendered.segments.some((segment) => segment.type === "ref"), false);
  assert.deepEqual(rendered.fact_bindings, []);
  assert.equal(rendered.reference_text, "AMD's EPS was [[F3]].");
});

test("a period's dates are written by month and year, never the day (#208)", () => {
  const windowed = { ...PACKET, figures: [{ ...PACKET.figures[0]!, metric: "Price return", period: "YTD 2026: 2025-12-31 close to 2026-08-31 close", value: "12.5%" }] };
  assert.equal(
    plainText(renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F1"] }, windowed, FACT_BLOCKS).segments),
    "NVDA's price return was 12.5% in YTD 2026: Dec 2025 close to Aug 2026 close.",
  );
});

test("a management attribution quotes its claim, dated and sourced; an unknown cause and an inference are labelled (#208)", () => {
  const attribution = renderAssertion({ index: 0, kind: "management_attribution", text: "x", evidence: ["C1"] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(attribution.segments), "According to a source, effective Feb 2026 on NVDA: Management cited a richer data-center mix.");
  // Dated by its publication; a differing effective date is said apart.
  const dated = { ...PACKET, claims: [{ ...PACKET.claims[0]!, effective_time: "2025-12-31T00:00:00.000Z", published_at: "2026-02-25T00:00:00.000Z" }] };
  assert.equal(
    plainText(renderAssertion({ index: 0, kind: "management_attribution", text: "x", evidence: ["C1"] }, dated, FACT_BLOCKS).segments),
    "According to a source dated Feb 2026, effective Dec 2025 on NVDA: Management cited a richer data-center mix.",
  );
  assert.deepEqual(attribution.segments.at(-1), { type: "ref", ref_kind: "claim", ref_id: CLAIM, format: "Management cited a richer data-center mix." });
  assert.deepEqual(attribution.source_refs, ["s-claim"]);
  const unknown = renderAssertion({ index: 1, kind: "unknown_cause", text: "x", evidence: ["F1"] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(unknown.segments), "The figures do not show why NVDA's gross margin changed.");
  const inference = renderAssertion({ index: 2, kind: "analyst_inference", text: "NVDA keeps more of each sale.", evidence: [], supports: [0] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(inference.segments), "> **Analyst inference:** NVDA keeps more of each sale.");
});

test("a stored quarter is written as prose writes it (#208)", () => {
  const quarterly = { ...PACKET, figures: [{ ...PACKET.figures[0]!, metric: "Revenue", period: "Q42026", value: "$57.0B" }] };
  assert.equal(plainText(renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F1"] }, quarterly, FACT_BLOCKS).segments), "NVDA's revenue was $57.0B in Q4 2026.");
});

test("an observation names each period's end month; calendars that end months apart are detected (#208)", () => {
  const ended = { ...PACKET, figures: [
    { ...PACKET.figures[0]!, period: "FY2026", period_end: "2026-01-25" },
    { ...PACKET.figures[1]!, period: "FY2026", period_end: "2025-12-27" },
  ] };
  assert.equal(
    plainText(renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F1", "F2"] }, ended, FACT_BLOCKS).segments),
    "NVDA's gross margin was 74.6% in FY2026 (ended Jan 2026); AMD's gross margin was 49.2% in FY2026 (ended Dec 2025).",
  );
  assert.equal(calendarsDiffer(ended.figures), true);
  assert.equal(calendarsDiffer(PACKET.figures), false);
});

// Comparisons (#208, slice 3): the derived result in a template, every value a fact ref.
const uuid = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quarter = (n: number, period: string, period_end: string, value: string, metric = "Operating margin") =>
  ({ id: `T${n}`, metric, period, period_end, value, fact_id: uuid(n), source_ids: [`s${n}`] });
const AMD_QUARTERS: EvidencePacket = {
  ...PACKET,
  companies: ["AMD"],
  claims: [],
  figures: [
    quarter(1, "Q1 2025", "2025-03-29", "10.8%"),
    quarter(2, "Q2 2025", "2025-06-28", "-1.7%"),
    quarter(3, "Q3 2025", "2025-09-27", "13.7%"),
    quarter(4, "Q4 2025", "2025-12-27", "14.1%"),
  ],
};
const QUARTER_BLOCKS = [{ id: "q", kind: "metric_row", data_ref: { params: { fact_bindings: [1, 2, 3, 4].map((n) => BINDING(uuid(n))) } } }];
const renderComparison = (packet: EvidencePacket, blocks: ReadonlyArray<Record<string, unknown>>, op: string, result: unknown, evidence: string[]) =>
  renderAssertion({ index: 0, kind: "comparison", op: op as "trend", result: result as string, text: "ignored", evidence }, packet, blocks);
const ALL = ["T1", "T2", "T3", "T4"];

test("a comparison over time renders its derived high, low or trend, values as fact refs (#208)", () => {
  const low = renderComparison(AMD_QUARTERS, QUARTER_BLOCKS, "lowest", "T2", ALL);
  assert.equal(plainText(low.segments), "AMD's operating margin was lowest in Q2 2025, at -1.7%, of the periods from Q1 2025 to Q4 2025.");
  assert.deepEqual(low.segments.filter((segment) => segment.type === "ref").map((segment) => segment.type === "ref" && segment.ref_id), [uuid(2)]);
  assert.equal(low.reference_text, "AMD's operating margin was lowest in Q2 2025, at [[T2]], of the periods from Q1 2025 to Q4 2025.");
  assert.equal(
    plainText(renderComparison(AMD_QUARTERS, QUARTER_BLOCKS, "trend", "rebounded", ALL).segments),
    "AMD's operating margin fell from 10.8% in Q1 2025 to a low of -1.7% in Q2 2025, then rebounded to 14.1% in Q4 2025, above where it started.",
  );
  assert.equal(
    plainText(renderComparison(AMD_QUARTERS, QUARTER_BLOCKS, "trend", "rose", ALL).segments),
    "AMD's operating margin rose from 10.8% in Q1 2025 to 14.1% in Q4 2025, though not in every period.",
  );
  // A subset of the window fails the check, so it renders nothing (and never reaches rendering).
  assert.equal(plainText(renderComparison(AMD_QUARTERS, QUARTER_BLOCKS, "trend", "rose_throughout", ["T3", "T4"]).segments), "");
  assert.equal(
    plainText(renderComparison(AMD_QUARTERS, QUARTER_BLOCKS, "order", ["T4", "T3", "T1", "T2"], ALL).segments),
    "AMD's operating margin, highest first: Q4 2025 14.1%, Q3 2025 13.7%, Q1 2025 10.8%, Q2 2025 -1.7%.",
  );
});

test("a ranking across companies lists every company's value and period, and names those not shown (#208)", () => {
  const peers: EvidencePacket = { ...PACKET, companies: ["NVDA", "AMD", "AAPL"], figures: PACKET.figures.slice(0, 2) };
  const rendered = renderComparison(peers, FACT_BLOCKS, "highest", "F1", ["F1", "F2"]);
  assert.equal(
    plainText(rendered.segments),
    "Of NVDA and AMD, NVDA's gross margin was highest: NVDA 74.6% (FY2026), AMD 49.2% (FY2025). No gross margin is shown for AAPL.",
  );
  assert.deepEqual(rendered.fact_bindings.map((binding) => binding.fact_id), [NVDA_GM, AMD_GM]);
  assert.deepEqual(rendered.source_refs, ["s-nvda", "s-amd"]);
  assert.equal(plainText(renderComparison(peers, FACT_BLOCKS, "order", ["F1", "F2"], ["F1", "F2"]).segments),
    "By gross margin, highest first: NVDA 74.6% (FY2026), AMD 49.2% (FY2025). No gross margin is shown for AAPL.");
});

test("a ranking over a price window writes its dates by month and year, as the guard allows (#301)", () => {
  const window = "YTD 2026: 2025-12-31 close to 2026-08-31 close";
  const returns: EvidencePacket = { ...PACKET, figures: [
    { id: "F5", company: "NVDA", metric: "Price return", period: window, value: "5.81%", source_ids: [] },
    { id: "F6", company: "AMD", metric: "Price return", period: window, value: "3.17%", source_ids: [] },
  ] };
  const rendered = renderComparison(returns, FACT_BLOCKS, "highest", "F5", ["F5", "F6"]);
  assert.equal(plainText(rendered.segments),
    "Of NVDA and AMD, NVDA's price return was highest: NVDA 5.81%, AMD 3.17% (YTD 2026: Dec 2025 close to Aug 2026 close).");
  assert.equal(rendered.reference_text,
    "Of NVDA and AMD, NVDA's price return was highest: NVDA [[F5]], AMD [[F6]] (YTD 2026: Dec 2025 close to Aug 2026 close).");
});

test("an observation names each period once, and segments and acronyms read as written (#208)", () => {
  const nvda = (n: number, metric: string, value: string, extra: Record<string, string> = {}) =>
    ({ id: `F${n}`, metric, period: "Q42026", period_end: "2026-01-25", value, fact_id: uuid(10 + n), source_ids: [], ...extra });
  const packet: EvidencePacket = { ...PACKET, companies: ["NVDA"], claims: [], figures: [
    nvda(1, "Gross margin", "74.4%"), nvda(2, "Operating margin", "64.9%"), nvda(3, "Revenue Growth (YoY)", "57.9%"),
    nvda(4, "Revenue", "$55.2B", { segment: "Data Center" }), nvda(5, "Revenue", "$4.3B", { segment: "Gaming" }),
  ] };
  const blocks = [{ id: "n", kind: "metric_row", data_ref: { params: { fact_bindings: [1, 2, 3, 4, 5].map((n) => BINDING(uuid(10 + n))) } } }];
  const text = (evidence: string[]) => plainText(renderAssertion({ index: 0, kind: "observation", text: "x", evidence }, packet, blocks).segments);
  assert.equal(text(["F1", "F2", "F3"]), "NVDA's gross margin was 74.4%, operating margin 64.9% and revenue growth (YoY) 57.9% in Q4 2026 (ended Jan 2026).");
  assert.equal(text(["F4", "F5"]), "NVDA's Data Center revenue was $55.2B and Gaming revenue $4.3B in Q4 2026 (ended Jan 2026).");
  assert.equal(
    plainText(renderComparison(packet, blocks, "highest", "F4", ["F4", "F5"]).segments),
    "Of NVDA's segments, Data Center revenue was highest: Data Center $55.2B, Gaming $4.3B (Q4 2026, ended Jan 2026).",
  );
});

test("an inference's label states each supporting comparison's checked result; one on observations alone keeps the plain label (#288)", () => {
  const comparisons = [
    { index: 0, kind: "comparison" as const, op: "trend" as const, result: "rebounded", text: "x", evidence: ALL },
    { index: 1, kind: "comparison" as const, op: "lowest" as const, result: "T2", text: "x", evidence: ALL },
    { index: 2, kind: "comparison" as const, op: "order" as const, result: ["T4", "T3", "T1", "T2"], text: "x", evidence: ALL },
    { index: 3, kind: "observation" as const, text: "x", evidence: ["T1"] },
  ];
  const label = (packet: EvidencePacket, supports: number[], accepted: ReadonlyArray<Assertion & { index: number }> = comparisons) =>
    plainText(renderAssertion({ index: 9, kind: "analyst_inference", text: "The loss quarter was a one-off.", evidence: [], supports }, packet, [], accepted).segments);
  assert.equal(label(AMD_QUARTERS, [0, 1, 3]),
    "> **Analyst inference** (AMD's operating margin fell, then rebounded; AMD's operating margin lowest in Q2 2025): The loss quarter was a one-off.");
  assert.equal(label(AMD_QUARTERS, [2]),
    "> **Analyst inference** (AMD's operating margin highest first: Q4 2025, Q3 2025, Q1 2025, Q2 2025): The loss quarter was a one-off.");
  assert.equal(label(AMD_QUARTERS, [3]), "> **Analyst inference:** The loss quarter was a one-off.");
  const peers: EvidencePacket = { ...PACKET, companies: ["NVDA", "AMD"], figures: PACKET.figures.slice(0, 2) };
  assert.equal(label(peers, [0], [{ index: 0, kind: "comparison", op: "order", result: ["F1", "F2"], text: "x", evidence: ["F1", "F2"] }]),
    "> **Analyst inference** (gross margin highest first: NVDA, AMD): The loss quarter was a one-off.");
  // One company highest on several metrics is said once.
  const margins: EvidencePacket = { ...peers, figures: [
    ...peers.figures,
    { id: "F4", company: "NVDA", metric: "Net margin", period: "FY2026", value: "55.0%", source_ids: [] },
    { id: "F5", company: "AMD", metric: "Net margin", period: "FY2025", value: "12.0%", source_ids: [] },
  ] };
  assert.equal(label(margins, [0, 1], [
    { index: 0, kind: "comparison", op: "highest", result: "F1", text: "x", evidence: ["F1", "F2"] },
    { index: 1, kind: "comparison", op: "highest", result: "F4", text: "x", evidence: ["F4", "F5"] },
  ]), "> **Analyst inference** (NVDA highest on gross margin and net margin): The loss quarter was a one-off.");
});
