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
    { id: "C2", text: "AMD management expects 10% revenue growth next year.", predicate: "guidance.change", stance: "supporting", company: "AMD", claim_id: "c2", source_id: "s2" },
    { id: "C1", text: "Management said a richer data-center mix lifted margins.", predicate: "kpi.commentary", stance: "supporting", company: "NVDA", effective_time: "2026-02-25T00:00:00.000Z", claim_id: "c1", source_id: "s1" },
  ],
  disagreements: [],
  claims_status: "available",
  claims_truncated: false,
};

const check = (list: unknown[]) => checkAssertions(list, PACKET);

test("the assertion list is cut from the prose wherever it is, and a broken one is malformed (#208)", () => {
  const list = '[{"kind":"observation","text":"x","evidence":["F1"]}]';
  assert.deepEqual(splitAssertions(`NVDA leads.\n\n\`\`\`assertions\n${list}\n\`\`\``), { prose: "NVDA leads.", list: JSON.parse(list), open: false });
  assert.deepEqual(splitAssertions(`NVDA leads.\n\`\`\`assertions\n${list}\n\`\`\`\nAMD trails.`).prose, "NVDA leads.\n\nAMD trails.");
  assert.deepEqual(splitAssertions("NVDA leads.\n```assertions\n[{\"kind\":"), { prose: "NVDA leads.", list: null, open: true });
  assert.deepEqual(splitAssertions("NVDA leads."), { prose: "NVDA leads.", list: undefined, open: false });
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

test("a claim's own numbers bind to it, for its company (#208)", () => {
  const report = check([
    { kind: "management_attribution", text: "AMD management expects 10% revenue growth.", evidence: ["C2"] },
    { kind: "management_attribution", text: "NVDA management expects 10% revenue growth.", evidence: ["C2"] },
  ]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [0]);
  assert.deepEqual(report.rejected.map((entry) => entry.reason), ["10% is not a cited figure's value for NVDA"]);
});

test("a cited period binds to its figure's company (#208)", () => {
  const report = check([
    { kind: "observation", text: "NVDA's margin was 75.0% in FY2025, and AMD's 49.4% in FY2026.", evidence: ["F1", "F3"] },
    { kind: "observation", text: "NVDA's margin was 75.0% in FY2026, and AMD's 49.4% in FY2025.", evidence: ["F1", "F3"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [[0, "2025 is not a cited figure's value for NVDA"]]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [1]);
});

test("a packet with claims but no figures is still checked; one with neither is skipped (#208)", () => {
  const claimsOnly = { ...PACKET, figures: [] };
  const report = checkAssertions([{ kind: "management_attribution", text: "AMD management expects 10% revenue growth.", evidence: ["C2"] }], claimsOnly);
  assert.equal(report.status, "checked");
  assert.equal(report.accepted.length, 1);
  assert.equal(checkAssertions([], { ...claimsOnly, claims: [] }).status, "skipped");
});

test("a company named right after a number (\"49.4% for AMD\") is that number's (#208)", () => {
  const report = check([
    { kind: "observation", text: "Margins were 49.4% for NVDA and 75.0% for AMD.", evidence: ["F1", "F3"] },
    { kind: "observation", text: "Margins were 75.0% for NVDA and 49.4% for AMD.", evidence: ["F1", "F3"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [[0, "49.4% is not a cited figure's value for NVDA"]]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [1]);
});

test("a claim with no company is no company's: it neither credits the first nor bars the right one (#208)", () => {
  const unowned = {
    ...PACKET,
    claims: [{ id: "C1", text: "Management reiterated 10% growth guidance.", predicate: "guidance.change", stance: "neutral" as const, claim_id: "c", source_id: "s" }],
  };
  const report = checkAssertions([
    { kind: "management_attribution", text: "AMD management reiterated 10% growth guidance.", evidence: ["C1"] },
    { kind: "management_attribution", text: "Management reiterated 10% growth guidance.", evidence: ["C1"] },
  ], unowned);
  assert.deepEqual(report.rejected, []);
});

test("malformed evidence or supports is rejected, not cleaned up (#208)", () => {
  const report = check([
    { kind: "observation", text: "NVDA's gross margin was 75.0%.", evidence: ["F1", null] },
    { kind: "observation", text: "NVDA's gross margin was 75.0%.", evidence: "F1" },
    { kind: "observation", text: "NVDA's gross margin was 75.0%.", evidence: ["F1"] },
    { kind: "analyst_inference", text: "NVDA's margin is high.", evidence: [], supports: [2, "0"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [
    [0, "evidence is not a list of packet ids"],
    [1, "evidence is not a list of packet ids"],
    [3, "supports is not a list of assertion indexes"],
  ]);
});

test("across companies, a value with no company beside it is unbound, whatever the phrasing (#208)", () => {
  const report = check([
    { kind: "observation", text: "75.0% was AMD's margin, while 49.4% was NVDA's.", evidence: ["F1", "F3"] },
    // One company's evidence: an unnamed value is its own.
    { kind: "observation", text: "Gross margin reached 75.0% in FY2026.", evidence: ["F1"] },
  ]);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [[0, "75.0% names no company, and its evidence spans several"]]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [1]);
});

test("a month and year must be a cited date's (#208)", () => {
  const dated = { ...PACKET, claims: [{ ...PACKET.claims[1]!, effective_time: "2026-02-25T00:00:00.000Z" }] };
  const report = checkAssertions([
    { kind: "management_attribution", text: "In February 2026, NVDA management credited a richer data-center mix.", evidence: ["C1"] },
    { kind: "management_attribution", text: "In March 2026, NVDA management credited a richer data-center mix.", evidence: ["C1"] },
  ], dated);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [[1, "March 2026 is not a cited date"]]);
});

test("an explicit plus, basis points or an abbreviated unit or month is parsed, not dropped (#208)", () => {
  const signed = { ...PACKET, figures: [...PACKET.figures, { id: "F5", company: "NVDA", metric: "YTD return", value: "-12.5%", source_ids: [] }] };
  const report = checkAssertions([
    { kind: "observation", text: "NVDA's YTD return was +12.5%.", evidence: ["F5"] },
    { kind: "observation", text: "NVDA's gross margin was 75 basis points.", evidence: ["F1"] },
    { kind: "observation", text: "AMD's revenue was $75.0bn.", evidence: ["F4"] },
    { kind: "management_attribution", text: "In Mar. 2026, NVDA management credited a richer data-center mix.", evidence: ["C1"] },
    { kind: "management_attribution", text: "In Feb 2026, NVDA management credited a richer data-center mix.", evidence: ["C1"] },
  ], signed);
  assert.deepEqual(report.rejected.map((entry) => [entry.index, entry.reason]), [
    [0, "+12.5% is not a cited figure's value"],
    [1, "75 basis points is not a cited figure's value"],
    [3, "March 2026 is not a cited date"],
  ]);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [2, 4]);
});

test("a leading-decimal value keeps its scale (#208)", () => {
  const report = check([{ kind: "observation", text: "NVDA's gross margin was .75%.", evidence: ["F1"] }]);
  assert.deepEqual(report.rejected.map((entry) => entry.reason), [".75% is not a cited figure's value"]);
});

test("with claims but no figures, only claim-bound assertions are checked; the rest are counted unchecked (#208)", () => {
  const report = checkAssertions([
    { kind: "observation", text: "ACME trades at $12.", evidence: [] },
    { kind: "management_attribution", text: "AMD management expects 10% revenue growth.", evidence: ["C2"] },
  ], { ...PACKET, figures: [] });
  assert.equal(report.status, "checked");
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.accepted.map((entry) => entry.index), [1]);
  assert.equal(report.unchecked, 1);
});
