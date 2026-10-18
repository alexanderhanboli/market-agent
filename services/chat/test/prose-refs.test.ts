import assert from "node:assert/strict";
import test from "node:test";

import type { EvidencePacket } from "../src/evidence-packet.ts";
import { displayOf, referenceTable, renderedText } from "../src/prose-refs.ts";

const NVDA_REVENUE = "a1000000-0000-4000-8000-000000000001";
const AMD_MARGIN = "a1000000-0000-4000-8000-000000000002";
const CLAIM = "c1000000-0000-4000-8000-000000000001";
const NVDA_LINE = "d1000000-0000-4000-8000-000000000001";
const PACKET: EvidencePacket = {
  route: "comparison",
  cutoff: "2026-09-01T00:00:00.000Z",
  companies: ["NVDA", "AMD"],
  figures: [
    { id: "F1", company: "NVDA", metric: "Revenue", period: "FY2026", period_end: "2026-01-25", value: "$209.9B", fact_id: NVDA_REVENUE, source_ids: ["s-nvda"] },
    { id: "F2", company: "AMD", metric: "Gross Margin", period: "FY2025", period_end: "2025-12-27", value: "49.9%", fact_id: AMD_MARGIN, source_ids: ["s-amd"] },
    // A price return read off its chart line: no fact behind it, its series instead.
    { id: "F3", company: "NVDA", metric: "Price return", period: "YTD 2026: 2025-12-31 close to 2026-08-31 close", value: "6.6%", series_ref: NVDA_LINE, source_ids: ["s-px"] },
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
const TABLE = referenceTable(PACKET);

test("the table holds every packet figure and claim by id", () => {
  assert.deepEqual([...TABLE.keys()], ["F1", "F2", "F3", "F4", "C1"]);
  assert.equal(displayOf(TABLE.get("F1")!), "$209.9B");
  assert.equal(displayOf(TABLE.get("C1")!), "These restrictions on MI308 GPUs led to approximately $800 million in charges.");
});

test("a sentence reads with each reference its packet value; one the table does not hold stays as written", () => {
  assert.equal(
    renderedText("NVDA's revenue was [[F1]] and its return [[F3]]; management said: [[C1]]", TABLE),
    "NVDA's revenue was $209.9B and its return 6.6%; management said: These restrictions on MI308 GPUs led to approximately $800 million in charges.",
  );
  assert.equal(renderedText("See [[F9]] and [[X1]].", TABLE), "See [[F9]] and [[X1]].");
});

