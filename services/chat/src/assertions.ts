// Evidence-bound assertions (#208), in shadow: the answer model lists what its
// prose asserts, each classified and citing evidence_packet ids ("F2", "C1").
// Company, metric, period and value come from the cited packet entries, never
// typed by the model, so a binding cannot name the wrong company or scale; the
// check here is that every id exists, that each kind cites what it must, and
// that the assertion's numbers and companies are its evidence's.
//
// Shadow: the report goes to evals and logs; the prose shown is unchanged. The
// controlled rendering from validated assertions is #208's second slice.

import type { EvidencePacket } from "./evidence-packet.ts";

export const ASSERTION_KINDS = ["observation", "management_attribution", "analyst_inference", "unknown_cause"] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export type Assertion = {
  kind: AssertionKind;
  text: string;
  evidence: ReadonlyArray<string>;
  // An inference's supporting observations, by their index in the list.
  supports?: ReadonlyArray<number>;
};

export type AssertionReport = {
  // missing: the answer listed none; malformed: the list did not parse;
  // skipped: no figures or claims, so there was nothing to bind (the answer
  // stood on available_data, which carries no packet ids).
  status: "missing" | "malformed" | "checked" | "skipped";
  accepted: ReadonlyArray<Assertion & { index: number }>;
  rejected: ReadonlyArray<{ index: number; text?: string; reason: string }>;
  // Assertions about figures when none were shown (the answer stood on
  // available_data, which carries no packet ids): neither accepted nor rejected.
  unchecked?: number;
};

export const MAX_ASSERTIONS = 8;

// The list closes the answer in a fenced block the reader never sees. Wherever
// it is, and closed or not, it is cut from the prose. open: the list never
// closed, so an answer cut off at the token limit inside it kept its prose
// whole (a cut after a closed list fell in the prose).
const FENCE = /```assertions[ \t]*\n([\s\S]*?)(?:```|$)/;

// The prose without its assertion list, and the list as written (undefined when
// there is none; null when it does not parse).
export function splitAssertions(text: string): { prose: string; list: unknown[] | null | undefined; open: boolean } {
  const match = FENCE.exec(text);
  if (!match) return { prose: text, list: undefined, open: false };
  const open = !match[0].endsWith("```");
  const prose = `${text.slice(0, match.index).trimEnd()}\n\n${text.slice(match.index + match[0].length).trimStart()}`.trim();
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    return { prose, list: Array.isArray(parsed) ? parsed : null, open };
  } catch {
    return { prose, list: null, open };
  }
}

export function checkAssertions(list: unknown[] | null | undefined, packet: EvidencePacket): AssertionReport {
  if (packet.figures.length === 0 && packet.claims.length === 0) return { status: "skipped", accepted: [], rejected: [] };
  if (list === undefined) return { status: "missing", accepted: [], rejected: [] };
  if (list === null) return { status: "malformed", accepted: [], rejected: [] };
  const figures = new Map(packet.figures.map((figure) => [figure.id, figure]));
  const claims = new Map(packet.claims.map((claim) => [claim.id, claim]));
  const accepted: Array<Assertion & { index: number }> = [];
  const rejected: Array<{ index: number; text?: string; reason: string }> = [];
  const reject = (index: number, item: unknown, reason: string) =>
    rejected.push({ index, ...(isRecord(item) && typeof item.text === "string" ? { text: item.text } : {}), reason });

  // Inferences last, so the observations they rest on are already checked.
  const order = list.map((item, index) => ({ item, index }))
    .sort((a, b) => Number(kindOf(a.item) === "analyst_inference") - Number(kindOf(b.item) === "analyst_inference"));
  let unchecked = 0;
  for (const { item, index } of order) {
    if (index >= MAX_ASSERTIONS) {
      reject(index, item, `more than ${MAX_ASSERTIONS} assertions`);
      continue;
    }
    if (!isRecord(item) || typeof item.text !== "string" || item.text.trim() === "") {
      reject(index, item, "not an assertion with text");
      continue;
    }
    const kind = kindOf(item);
    if (kind === undefined) {
      reject(index, item, `unknown kind ${JSON.stringify(item.kind)}`);
      continue;
    }
    // A malformed list is the model's error to report, never cleaned up.
    if (!Array.isArray(item.evidence) || !item.evidence.every((id) => typeof id === "string")) {
      reject(index, item, "evidence is not a list of packet ids");
      continue;
    }
    if (item.supports !== undefined && (!Array.isArray(item.supports) || !item.supports.every((n) => Number.isInteger(n)))) {
      reject(index, item, "supports is not a list of assertion indexes");
      continue;
    }
    // Well-formed, but about figures when none were shown: nothing to bind.
    if (packet.figures.length === 0 && kind !== "management_attribution") {
      unchecked++;
      continue;
    }
    const evidence = item.evidence as string[];
    const unknown = evidence.find((id) => !figures.has(id) && !claims.has(id));
    if (unknown !== undefined) {
      reject(index, item, `unknown evidence id ${JSON.stringify(unknown)}`);
      continue;
    }
    const figureIds = evidence.filter((id) => figures.has(id));
    const claimIds = evidence.filter((id) => claims.has(id));
    const supports = (item.supports ?? []) as number[];
    const shape = shapeError(kind, figureIds, claimIds, supports, accepted);
    if (shape) {
      reject(index, item, shape);
      continue;
    }
    // An inference's evidence is its own plus that of the observations it rests on.
    const cited = kind === "analyst_inference"
      ? [...evidence, ...accepted.filter((entry) => supports.includes(entry.index)).flatMap((entry) => entry.evidence)]
      : evidence;
    const binding = bindingError(item.text, cited, packet);
    if (binding) {
      reject(index, item, binding);
      continue;
    }
    accepted.push({ index, kind, text: item.text, evidence, ...(kind === "analyst_inference" ? { supports } : {}) });
  }
  accepted.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);
  return { status: "checked", accepted, rejected, ...(unchecked > 0 ? { unchecked } : {}) };
}

// What each kind must cite.
// ponytail: a management attribution needs a claim, not proof that the claim
// states that cause; that is judged by the held-out evaluation (#221).
function shapeError(
  kind: AssertionKind,
  figureIds: ReadonlyArray<string>,
  claimIds: ReadonlyArray<string>,
  supports: ReadonlyArray<number>,
  accepted: ReadonlyArray<Assertion & { index: number }>,
): string | null {
  switch (kind) {
    case "observation":
      return figureIds.length === 0 || claimIds.length > 0 ? "an observation cites figures, and only figures" : null;
    case "unknown_cause":
      return figureIds.length === 0 || claimIds.length > 0 ? "an unknown cause cites the figures that changed, and no claim" : null;
    case "management_attribution":
      return claimIds.length === 0 ? "a management attribution cites the claim that makes it" : null;
    case "analyst_inference": {
      const observations = new Set(accepted.filter((entry) => entry.kind === "observation").map((entry) => entry.index));
      return supports.length === 0 || !supports.every((n) => observations.has(n))
        ? "an inference binds the accepted observations it rests on"
        : null;
    }
  }
}

// Every number the text states binds to one piece of its evidence, which
// belongs to the company the text last named before it: a cited figure's value
// (in its unit, sign allowing), its period or year, or a number a cited claim
// states. A bare number may match any of them; one with a unit, sign or
// currency must match in kind. Every company the text names must be its
// evidence's.
// ponytail: the metric is not matched; two cited figures with the same value
// and unit under different metrics are interchangeable here.
function bindingError(text: string, cited: ReadonlyArray<string>, packet: EvidencePacket): string | null {
  const figures = packet.figures.filter((figure) => cited.includes(figure.id));
  const claims = packet.claims.filter((claim) => cited.includes(claim.id));
  // A figure with no company is the only company's; a claim with none is no
  // company's (its record named none), so it binds a number for any.
  const companyOf = (company: string | undefined) => company ?? packet.companies[0];
  const sources = [
    ...figures.flatMap((figure) => [figure.value, figure.period ?? "", figure.period_end?.slice(0, 4) ?? ""]
      .map((source) => ({ source, company: companyOf(figure.company) }))),
    ...claims.flatMap((claim) => [claim.text, claim.effective_time?.slice(0, 4) ?? "", claim.published_at?.slice(0, 4) ?? ""]
      .map((source) => ({ source, company: claim.company }))),
  ];
  const evidence = sources.flatMap(({ source, company }) => quantities(source).map((quantity) => ({ quantity, company })));
  // Evidence spanning companies leaves a value's company to its phrasing; one
  // with no company named before it (or right after it, "for AMD") is unbound
  // rather than guessed ("75.0% was AMD's margin").
  const spans = new Set(evidence.flatMap((entry) => (entry.company ? [entry.company] : []))).size > 1;
  for (const quantity of quantities(text)) {
    const candidates = evidence.filter((entry) => sameQuantity(quantity, entry.quantity));
    if (candidates.length === 0) return `${quantity.raw} is not a cited figure's value`;
    const named = companyAfter(text, quantity.at + quantity.raw.length, packet.companies)
      ?? lastCompanyBefore(text, quantity.at, packet.companies);
    if (named === undefined && spans && (quantity.unit || quantity.currency || quantity.negative || quantity.positive)) {
      return `${quantity.raw} names no company, and its evidence spans several`;
    }
    if (named !== undefined && !candidates.some((entry) => entry.company === named || entry.company === undefined)) {
      return `${quantity.raw} is not a cited figure's value for ${named}`;
    }
  }
  // A month the text dates something by is a cited date's: a claim's, or the
  // month a figure's period ends in.
  const months = new Set([
    ...claims.flatMap((claim) => [claim.effective_time, claim.published_at]),
    ...figures.map((figure) => figure.period_end),
  ].flatMap((date) => (date ? [monthYear(date)] : [])));
  for (const match of text.matchAll(MONTH_YEAR)) {
    const month = `${MONTHS.find((name) => name.slice(0, 3).toLowerCase() === match[1]!.slice(0, 3).toLowerCase())} ${match[2]}`;
    if (!months.has(month)) return `${month} is not a cited date`;
  }
  if (claims.some((claim) => claim.company === undefined)) return null;
  const own = new Set([...figures.map((figure) => companyOf(figure.company)), ...claims.map((claim) => claim.company)]);
  const other = packet.companies.find((company) => !own.has(company) && mentions(text, company));
  return other === undefined ? null : `names ${other}, which its evidence does not`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Full or abbreviated ("Mar", "Sept."), each read as its full name.
const MONTH_YEAR = new RegExp(`\\b(${MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)}|t(?=\\.))?`).join("|")})\\.?\\s+(\\d{4})\\b`, "gi");

function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

// currency: its prefix as written ("$", "€", "CN¥"), "" for none.
type Quantity = { raw: string; at: number; value: string; unit: string; currency: string; negative: boolean; positive: boolean };

// Numbers with their sign, currency prefix and unit; the value compared as a number,
// so "75%" is the "75.0%" shown while "7.5" is not "75".
const QUANTITY = /(?<![\d.])([-−+])?((?:(?<![A-Za-z])[A-Z]{1,2})?[$€£¥])?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:\s*(%|x\b|[KMBT]\b|bn\b|mn\b|thousand\b|million\b|billion\b|trillion\b|basis points?\b|bps?\b))?/gi;
const UNITS: Readonly<Record<string, string>> = {
  thousand: "K", million: "M", mn: "M", billion: "B", bn: "B", trillion: "T",
  "basis point": "bp", "basis points": "bp", bp: "bp", bps: "bp",
};

function quantities(text: string): Quantity[] {
  return [...text.matchAll(QUANTITY)].map((match) => {
    const unit = (match[4] ?? "").toLowerCase();
    return {
      raw: match[0].trim(),
      at: match.index,
      value: String(Number(match[3]!.replace(/,/g, ""))),
      unit: UNITS[unit] ?? (unit === "%" || unit === "x" ? unit : unit.toUpperCase()),
      currency: (match[2] ?? "").replace(/^US\$$/, "$"),
      negative: match[1] !== undefined && match[1] !== "+",
      positive: match[1] === "+",
    };
  });
}

// The same value in the same unit. A sign the text adds must be the figure's;
// a negative figure may be told in words ("fell 3.2%"). A unit or currency the
// text leaves out is not a mismatch ("62.1" of "$62.1B").
function sameQuantity(text: Quantity, figure: Quantity): boolean {
  if (text.value !== figure.value) return false;
  if (text.negative && !figure.negative) return false;
  if (text.positive && figure.negative) return false;
  if (text.unit && text.unit !== figure.unit) return false;
  return !text.currency || text.currency === figure.currency;
}

// A company named right after the number, by a preposition ("49.4% for AMD").
function companyAfter(text: string, end: number, companies: ReadonlyArray<string>): string | undefined {
  const rest = text.slice(end);
  return companies.find((company) => {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*(?:for|at|of|from|by|in)\\s+${escaped}(?![A-Za-z0-9])`).test(rest);
  });
}

function lastCompanyBefore(text: string, at: number, companies: ReadonlyArray<string>): string | undefined {
  let last: { company: string; at: number } | undefined;
  for (const company of companies) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of text.slice(0, at).matchAll(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"))) {
      if (!last || match.index > last.at) last = { company, at: match.index };
    }
  }
  return last?.company;
}

function mentions(text: string, company: string): boolean {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`).test(text);
}

function kindOf(item: unknown): AssertionKind | undefined {
  return isRecord(item) && ASSERTION_KINDS.includes(item.kind as AssertionKind) ? item.kind as AssertionKind : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
