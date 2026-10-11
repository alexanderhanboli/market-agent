import test from "node:test";
import assert from "node:assert/strict";

import { checkAssertions, splitAssertions } from "../src/assertions.ts";
import type { EvidencePacket } from "../src/evidence-packet.ts";

const PACKET: EvidencePacket = {
  route: "comparison",
  cutoff: "2026-09-01T00:00:00.000Z",
  companies: ["NVDA", "AMD"],
  figures: [
    { id: "F1", company: "NVDA", metric: "Gross margin", period: "FY2026", value: "75.0%", source_ids: [] },
    { id: "F2", company: "NVDA", metric: "Gross margin", period: "FY2025", value: "72.7%", source_ids: [] },
    { id: "F3", company: "AMD", metric: "Gross margin", period: "FY2025", value: "49.4%", source_ids: [] },
    { id: "F4", company: "AMD", metric: "Revenue", period: "FY2025", value: "$75.0B", source_ids: [] },
  ],
  coverage: [],
  gaps: [],
  query_bounds: {},
  claims: [
    { id: "C1", text: "Management said a richer data-center mix lifted margins.", predicate: "kpi.commentary", stance: "supporting", company: "NVDA", effective_time: "2026-02-25T00:00:00.000Z", claim_id: "c1", source_id: "s1" },
  ],
  disagreements: [],
  claims_status: "available",
  claims_truncated: false,
};

const check = (list: unknown[]) => checkAssertions(list, PACKET);

test("the assertion list is cut from the prose wherever it is, and a broken one is malformed (#208)", () => {
  const list = '[{"kind":"observation","text":"x","evidence":["F1"]}]';
  assert.deepEqual(splitAssertions(`NVDA leads.\n\n\`\`\`assertions\n${list}\n\`\`\``), { prose: "NVDA leads.", list: JSON.parse(list) });
  assert.deepEqual(splitAssertions(`NVDA leads.\n\`\`\`assertions\n${list}\n\`\`\`\nAMD trails.`).prose, "NVDA leads.\n\nAMD trails.");
  assert.deepEqual(splitAssertions("NVDA leads.\n```assertions\n[{\"kind\":"), { prose: "NVDA leads.", list: null });
  assert.deepEqual(splitAssertions("NVDA leads."), { prose: "NVDA leads.", list: undefined });
  assert.equal(checkAssertions(undefined, PACKET).status, "missing");
  assert.equal(checkAssertions(null, PACKET).status, "malformed");
});

test("a margin change with no causal claim is an observation plus an unknown cause (#208)", () => {
  const report = check([
    { kind: "observation", text: "NVDA's gross margin rose from 72.7% in FY2025 to 75.0% in FY2026.", evidence: ["F2", "F1"] },
    { kind: "unknown_cause", text: "The figures do not show why NVDA's margin rose.", evidence: ["F1", "F2"] },
  ]);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.accepted.map((entry) => entry.kind), ["observation", "unknown_cause"]);
  // A value written without its trailing zero is the same value.
  assert.deepEqual(check([{ kind: "observation", text: "NVDA's gross margin was 75% in FY2026.", evidence: ["F1"] }]).rejected, []);
});

test("each kind cites what it must (#208)", () => {
  const report = check([
    { kind: "management_attribution", text: "Management credited a richer mix.", evidence: ["F1"] },
    { kind: "observation", text: "Management credited a richer mix.", evidence: ["C1"] },
    { kind: "unknown_cause", text: "The cause is not shown.", evidence: ["C1", "F1"] },
    { kind: "management_attribution", text: "NVDA management credited a richer data-center mix.", evidence: ["C1"] },
    { kind: "guess", text: "Margins will rise.", evidence: ["F1"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => entry.reason), [
    "a management attribution cites the claim that makes it",
    "an observation cites figures, and only figures",
    "an unknown cause cites the figures that changed, and no claim",
    'unknown kind "guess"',
  ]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [3]);
});

test("an inference binds accepted observations, and states only their numbers (#208)", () => {
  const report = check([
    { kind: "observation", text: "NVDA's gross margin was 75.0% in FY2026.", evidence: ["F1"] },
    { kind: "observation", text: "AMD's gross margin was 49.4% in FY2025.", evidence: ["F3"] },
    { kind: "analyst_inference", text: "NVDA's 75.0% margin outruns AMD's 49.4%.", evidence: [], supports: [0, 1] },
    { kind: "analyst_inference", text: "NVDA prices with more power.", evidence: [] },
    { kind: "analyst_inference", text: "NVDA's margin is higher.", evidence: [], supports: [4] },
    { kind: "analyst_inference", text: "NVDA's 80% margin leads.", evidence: [], supports: [0] },
  ]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [0, 1, 2]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [
    [3, "an inference binds the accepted observations it rests on"],
    [4, "an inference binds the accepted observations it rests on"],
    [5, "80% is not a cited figure's value"],
  ]);
});

test("a matching number is not enough: the wrong company, scale or id is rejected (#208)", () => {
  const report = check([
    // 49.4% is a real figure, but AMD's: NVDA's evidence does not hold it.
    { kind: "observation", text: "NVDA's gross margin was 49.4%.", evidence: ["F1"] },
    // Its own figure, credited to another company.
    { kind: "observation", text: "AMD's gross margin was 75.0%.", evidence: ["F1"] },
    { kind: "observation", text: "NVDA's gross margin was 7.50%.", evidence: ["F1"] },
    { kind: "observation", text: "NVDA's gross margin was 75.0%.", evidence: ["F9"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => entry.reason), [
    "49.4% is not a cited figure's value",
    "75.0% is not a cited figure's value for AMD",
    "7.50% is not a cited figure's value",
    'unknown evidence id "F9"',
  ]);
  assert.equal(report.accepted.length, 0);
});

test("at most eight assertions are checked; the rest are rejected (#208)", () => {
  const one = { kind: "observation", text: "NVDA's gross margin was 75.0%.", evidence: ["F1"] };
  const report = check(Array.from({ length: 10 }, () => one));
  assert.equal(report.accepted.length, 8);
  assert.deepEqual(report.rejected.map((entry) => entry.index), [8, 9]);
});

test("a company the text names must be its evidence's (#208)", () => {
  assert.deepEqual(check([{ kind: "observation", text: "NVDA's gross margin was 75.0%, ahead of AMD.", evidence: ["F1"] }]).rejected.map((entry) => entry.reason), [
    "names AMD, which its evidence does not",
  ]);
});

test("each number binds to one cited figure: its unit, sign and company, not pooled digits (#208)", () => {
  const report = check([
    // AMD's $75.0B revenue is not a 75.0% margin, nor -75.0%.
    { kind: "observation", text: "AMD's gross margin was 75.0%.", evidence: ["F4"] },
    { kind: "observation", text: "AMD's revenue fell -75.0B.", evidence: ["F4"] },
    // Both companies cited, but each value credited to the other.
    { kind: "observation", text: "NVDA's margin was 49.4% and AMD's was 75.0%.", evidence: ["F1", "F3"] },
    { kind: "observation", text: "NVDA's margin was 75.0% and AMD's was 49.4%.", evidence: ["F1", "F3"] },
    { kind: "observation", text: "AMD's revenue was $75.0 billion in FY2025.", evidence: ["F4"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [
    [0, "75.0% is not a cited figure's value"],
    [1, "-75.0B is not a cited figure's value"],
    [2, "49.4% is not a cited figure's value for NVDA"],
  ]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [3, 4]);
});
