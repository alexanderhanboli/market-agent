import test from "node:test";
import assert from "node:assert/strict";

import { calendarsDiffer, plainText, renderAssertion } from "../src/render-assertions.ts";
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

test("a value whose fact cannot seal here is plain text (#208)", () => {
  const rendered = renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F3"] }, PACKET, FACT_BLOCKS);
  assert.equal(plainText(rendered.segments), "AMD's EPS was $1.37.");
  assert.equal(rendered.segments.some((segment) => segment.type === "ref"), false);
  assert.deepEqual(rendered.fact_bindings, []);
  // So it is marked unsealed, and the answer does not render it.
  assert.equal(rendered.unsealed, true);
  assert.equal(renderAssertion({ index: 0, kind: "observation", text: "x", evidence: ["F1"] }, PACKET, FACT_BLOCKS).unsealed, false);
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
