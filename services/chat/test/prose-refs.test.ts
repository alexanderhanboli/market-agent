import assert from "node:assert/strict";
import test from "node:test";

import type { EvidencePacket } from "../src/evidence-packet.ts";
import { displayOf, onlyPeriodDigits, proseSegments, referenceTable, referenceText } from "../src/prose-refs.ts";

const NVDA_REVENUE = "a1000000-0000-4000-8000-000000000001";
const AMD_MARGIN = "a1000000-0000-4000-8000-000000000002";
const CLAIM = "c1000000-0000-4000-8000-000000000001";
const binding = (fact_id: string) => ({ fact_id, unit: "USD", period_kind: "fiscal_y", fiscal_year: 2026, fiscal_period: "FY", period_end: "2026-01-25", source_id: "s" });
const BLOCKS = [{
  id: "b1",
  kind: "metrics_comparison",
  title: "Side by side: NVDA FY2026 (ended Jan 2026), AMD FY2025 (ended Dec 2025)",
  data_ref: { kind: "metrics_comparison", id: "b1", params: { fact_bindings: [binding(NVDA_REVENUE), binding(AMD_MARGIN)] } },
}];
const PACKET: EvidencePacket = {
  route: "comparison",
  cutoff: "2026-09-01T00:00:00.000Z",
  companies: ["NVDA", "AMD"],
  figures: [
    { id: "F1", company: "NVDA", metric: "Revenue", period: "FY2026", period_end: "2026-01-25", value: "$209.9B", fact_id: NVDA_REVENUE, source_ids: ["s-nvda"] },
    { id: "F2", company: "AMD", metric: "Gross Margin", period: "FY2025", period_end: "2025-12-27", value: "49.9%", fact_id: AMD_MARGIN, source_ids: ["s-amd"] },
    // A price return read off its chart: no fact behind it.
    { id: "F3", company: "NVDA", metric: "Price return", period: "YTD 2026: 2025-12-31 close to 2026-08-31 close", value: "6.6%", source_ids: [] },
    { id: "F4", company: "NVDA", metric: "P/E", period: "Q42026", value: "52.3x", fact_id: "not-a-uuid", source_ids: [] },
  ],
  coverage: [],
  gaps: [],
  query_bounds: { claims: "management claims from 2024-09-01 first, published by the 2026-09-01 cutoff" },
  claims: [{ id: "C1", text: "These restrictions on MI308 GPUs led to approximately $800 million in charges.", predicate: "management.explanation.other", stance: "challenging", company: "AMD", published_at: "2025-08-05T00:00:00.000Z", claim_id: CLAIM, source_id: "s-claim" }],
  disagreements: [],
  claims_status: "available",
  claims_truncated: false,
};
const TABLE = referenceTable(PACKET, BLOCKS);

test("a name with digits passes only from the turn's names: a segment, metric, title or company label, never a claim", () => {
  const packet = { ...PACKET, figures: [...PACKET.figures, { id: "F5", company: "AMD", metric: "Revenue", segment: "MI300 accelerators", period: "FY2025", value: "$5.0B", source_ids: [] }] };
  const table = referenceTable(packet, BLOCKS);
  assert.deepEqual([...table.words].sort(), ["MI300"]);
  assert.equal(onlyPeriodDigits("MI300 sales rose.", table), true);
  assert.equal(onlyPeriodDigits("Export rules on the MI308 weighed on AMD, as [[C1]] says.", table), false);
});

test("a company label's period-shaped token opens no year; a letter-led one is a name", () => {
  const packet = { ...PACKET, companies: ["2025.HK", "BRK3"] };
  const table = { ...referenceTable(packet, BLOCKS), years: new Set<string>() };
  assert.equal(onlyPeriodDigits("Revenue rose in 2025.", table), false);
  assert.equal(onlyPeriodDigits("BRK3 reported.", table), true);
});

test("a period-shaped word is judged only as a period, and an amount never passes as a name", () => {
  const packet = { ...PACKET, claims: [{ ...PACKET.claims[0]!, text: "Charges totaled USD800M in FY2025 on MI308 parts." }] };
  const table = referenceTable(packet, BLOCKS);
  const noYears = { ...table, years: new Set<string>() };
  assert.equal(onlyPeriodDigits("Revenue was USD800M.", table), false);
  assert.equal(onlyPeriodDigits("Revenue in FY2025, per [[C1]].", noYears), false);
  assert.equal(onlyPeriodDigits("Charges hit MI308 parts, per [[C1]].", table), false);
  assert.equal(onlyPeriodDigits("Revenue in FY２０２５.", table), false);
});

test("a product name shaped like a half-year label (H100) is a name, not a period", () => {
  const table = referenceTable(PACKET, [...BLOCKS, { kind: "metric_row", title: "H100 systems revenue" }]);
  assert.equal(onlyPeriodDigits("H100 demand held up.", table), true);
  assert.equal(onlyPeriodDigits("Revenue in H1 2026.", table), true);
});

test("digits in any script are digits: full-width and Arabic-Indic numbers do not pass", () => {
  assert.equal(onlyPeriodDigits("Revenue was ２ billion.", TABLE), false);
  assert.equal(onlyPeriodDigits("Revenue was ٣ billion.", TABLE), false);
});

test("the table holds every packet figure and claim by id, and the years of its periods, dates, bounds and titles", () => {
  assert.deepEqual([...TABLE.references.keys()], ["F1", "F2", "F3", "F4", "C1"]);
  assert.equal(displayOf(TABLE.references.get("F1")!), "$209.9B");
  assert.equal(displayOf(TABLE.references.get("C1")!), "These restrictions on MI308 GPUs led to approximately $800 million in charges.");
  assert.deepEqual([...TABLE.years].sort(), ["2024", "2025", "2026"]);
});

test("digits outside a reference pass only as a period: an allowed year, or a quarter or half after Q or H", () => {
  for (const kept of [
    "NVDA's revenue was [[F1]] in FY2026 (ended January 2026).",
    "Q4 2026 and H1 2025 are shown; fiscal 2026 ran to 2026.",
    "Revenue grew over 2025-2026.",
    "The [[C1]] restrictions weighed on Q2.",
    "No digits here.",
  ]) {
    assert.equal(onlyPeriodDigits(kept, TABLE), true, kept);
  }
  for (const dropped of [
    "Revenue grew 38% year over year.",
    "The window ran from December 31, 2025.",
    "Eight quarters are shown, 8 in all.",
    "Revenue was $209.9B.",
    "Q5 2026 is no quarter.",
    "Results since 2019.",
    "Q42026 is the stored form, not a period label.",
    "Demand for the H200 rose.",
    "Export rules on the MI308 weighed on AMD.",
    "AMD sold 308 units.",
  ]) {
    assert.equal(onlyPeriodDigits(dropped, TABLE), false, dropped);
  }
  // With no years allowed, any year is a digit; a quarter label still passes.
  assert.equal(onlyPeriodDigits("Revenue in FY2026.", { years: new Set(), words: new Set() }), false);
  assert.equal(onlyPeriodDigits("Revenue in Q4.", { years: new Set(), words: new Set() }), true);
});

test("prose converts to segments: a sealed fact ref, a claim ref, and plain text for a figure with no fact to seal", () => {
  const converted = proseSegments("NVDA's revenue was [[F1]] versus AMD's margin of [[F2]]; management said: [[C1]] Its return was [[F3]] and P/E [[F4]].", TABLE, BLOCKS);
  assert.deepEqual(converted.segments, [
    { type: "text", text: "NVDA's revenue was " },
    { type: "ref", ref_kind: "fact", ref_id: NVDA_REVENUE, format: "$209.9B" },
    { type: "text", text: " versus AMD's margin of " },
    { type: "ref", ref_kind: "fact", ref_id: AMD_MARGIN, format: "49.9%" },
    { type: "text", text: "; management said: " },
    { type: "ref", ref_kind: "claim", ref_id: CLAIM, format: "These restrictions on MI308 GPUs led to approximately $800 million in charges." },
    { type: "text", text: " Its return was 6.6% and P/E 52.3x." },
  ]);
  assert.deepEqual(converted.fact_bindings.map((entry) => entry.fact_id), [NVDA_REVENUE, AMD_MARGIN]);
  assert.deepEqual(converted.source_refs, ["s-nvda", "s-amd", "s-claim"]);
});

test("a unit the model repeats beside a reference is dropped only when the value already carries it", () => {
  const text = (prose: string) => proseSegments(prose, TABLE, BLOCKS).segments.map((segment) => (segment.type === "text" ? segment.text : segment.format)).join("");
  assert.equal(text("Revenue of $[[F1]] and a margin of [[F2]]%, at [[F4]]x."), "Revenue of $209.9B and a margin of 49.9%, at 52.3x.");
  assert.equal(text("Revenue of [[F1]]B."), "Revenue of $209.9B.");
  // A unit the value does not carry, or a word, stays as written.
  assert.equal(text("Revenue of [[F1]]% and €[[F1]] and [[F1]]Billion."), "Revenue of $209.9B% and €$209.9B and $209.9BBillion.");
});

test("a reference the table does not hold stays as written, and text with no reference is one segment", () => {
  assert.deepEqual(proseSegments("See [[F9]] and [[X1]].", TABLE, BLOCKS).segments, [{ type: "text", text: "See [[F9]] and [[X1]]." }]);
  assert.deepEqual(proseSegments("Margins held up.", TABLE, BLOCKS), { segments: [{ type: "text", text: "Margins held up." }], fact_bindings: [], source_refs: [] });
});

test("rendered segments read back as prose with references, by fact or claim id", () => {
  const prose = referenceText([
    { type: "text", text: "NVDA's revenue was " },
    { type: "ref", ref_kind: "fact", ref_id: NVDA_REVENUE, format: "$209.9B" },
    { type: "text", text: " in Q4 2026; " },
    { type: "ref", ref_kind: "claim", ref_id: CLAIM, format: "ignored" },
    { type: "ref", ref_kind: "fact", ref_id: "unknown", format: "12%" },
  ], TABLE);
  assert.equal(prose, "NVDA's revenue was [[F1]] in Q4 2026; [[C1]]12%");
});
