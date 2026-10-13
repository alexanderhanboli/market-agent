// Evidence-bound assertions (#208), in shadow: the answer model lists what its
// prose asserts, each classified and citing evidence_packet ids ("F2", "C1").
// Company, metric, period and value come from the cited packet entries, never
// typed by the model, so a binding cannot name the wrong company or scale; the
// check here is that every id exists, that each kind cites what it must, and
// that the assertion's numbers and companies are its evidence's.
//
// Shadow: the report goes to evals and logs; the prose shown is unchanged. The
// controlled rendering from validated assertions is #208's second slice.

import { checkComparison, type ComparisonOp } from "./comparisons.ts";
import type { EvidencePacket } from "./evidence-packet.ts";
import { requestedMetrics } from "./research-scope.ts";

export const ASSERTION_KINDS = ["observation", "comparison", "management_attribution", "analyst_inference", "unknown_cause"] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export type Assertion = {
  kind: AssertionKind;
  text: string;
  evidence: ReadonlyArray<string>;
  // An inference's supporting observations and comparisons, by their index in the list.
  supports?: ReadonlyArray<number>;
  // A comparison's operation and claimed result (comparisons.ts): the high or
  // low's id, the ids highest first, or a trend's result.
  op?: ComparisonOp;
  result?: string | ReadonlyArray<string>;
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
  // The answer was written from the accepted assertions (controlled rendering).
  rendered?: boolean;
};

// The answer is rendered from this list (#208), so it holds a comparison
// answer's observations, a comparison per metric, the takeaway and the
// counterpoint; at 8, counterpoints fell past the cap (2026-10-13 eval).
export const MAX_ASSERTIONS = 12;

// The list closes the answer in a fenced block the reader never sees. Wherever
// it is, and closed or not, it is cut from the prose. open: the list never
// closed, so an answer cut off at the token limit inside it kept its prose
// whole (a cut after a closed list fell in the prose).
const FENCES = /[ \t]*```assertions[ \t]*\r?\n([\s\S]*?)(?:(```)|$)[ \t]*/g;

// The prose without its assertion list, and the list as written (undefined when
// there is none; null when it does not parse).
export function splitAssertions(text: string): { prose: string; list: unknown[] | null | undefined; open: boolean } {
  const matches = [...text.matchAll(FENCES)];
  if (matches.length === 0) return { prose: text, list: undefined, open: false };
  // Every block is cut, so a second (a corrected list) never shows; the first
  // is the one checked.
  const prose = text.replace(FENCES, "\n\n").replace(/(?:\r?\n){3,}/g, "\n\n").trim();
  // Closed when its closing fence matched, whatever spaces follow it.
  const open = matches.at(-1)![2] === undefined;
  try {
    const parsed: unknown = JSON.parse(matches[0]![1]!);
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
  // Observations that passed every check they could take, with no figures to bind.
  const uncheckedObservations = new Set<number>();
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
    // A malformed list is the model's error to report, never cleaned up. An
    // inference cites through its supports, so its own evidence may be left out.
    const listed = item.evidence === undefined && kind === "analyst_inference" ? [] : item.evidence;
    if (!Array.isArray(listed) || !listed.every((id) => typeof id === "string")) {
      reject(index, item, "evidence is not a list of packet ids");
      continue;
    }
    if (item.supports !== undefined && kind !== "analyst_inference") {
      reject(index, item, "only an analyst inference lists supports");
      continue;
    }
    if ((item.op !== undefined || item.result !== undefined) && kind !== "comparison") {
      reject(index, item, "only a comparison has an op and a result");
      continue;
    }
    if (item.supports !== undefined && (!Array.isArray(item.supports) || !item.supports.every((n) => Number.isInteger(n)))) {
      reject(index, item, "supports is not a list of assertion indexes");
      continue;
    }
    const evidence = listed as string[];
    const unknown = evidence.find((id) => !figures.has(id) && !claims.has(id));
    if (unknown !== undefined) {
      reject(index, item, `unknown evidence id ${JSON.stringify(unknown)}`);
      continue;
    }
    const figureIds = evidence.filter((id) => figures.has(id));
    const claimIds = evidence.filter((id) => claims.has(id));
    // About figures when none were shown: nothing to bind, unless it cites a
    // claim where only figures may stand.
    if (packet.figures.length === 0 && kind !== "management_attribution") {
      if ((kind === "observation" || kind === "comparison" || kind === "unknown_cause") && claimIds.length > 0) {
        reject(index, item, shapeError(kind, [], claimIds, [], accepted)!);
      } else if (kind === "analyst_inference" && !restsOnObservations(item.supports, uncheckedObservations)) {
        reject(index, item, "an inference binds the accepted observations it rests on");
      } else {
        unchecked++;
        if (kind === "observation") uncheckedObservations.add(index);
      }
      continue;
    }
    const shape = shapeError(kind, figureIds, claimIds, (item.supports ?? []) as number[], accepted);
    if (shape) {
      reject(index, item, shape);
      continue;
    }
    // An inference keeps the supports that were accepted (shapeError requires one).
    const supports = ((item.supports ?? []) as number[]).filter((n) => accepted.some((entry) => entry.index === n));
    // An unknown cause is a change's: each figure it cites has its company's
    // same metric in another period with a different value beside it.
    if (kind === "unknown_cause" && !showsChange(figureIds.map((id) => figures.get(id)!), packet.figures)) {
      reject(index, item, "an unknown cause cites a change: one company's metric, two periods, two values");
      continue;
    }
    // A metric the question asked for that no reader serves is a named gap: no
    // other figure stands in for it ("free cash flow" from net income).
    // Read with the question's own metric names, so "FCF" is free cash flow.
    // A management attribution cites its claim, never a figure, so a claim
    // about the missing metric may be attributed.
    const gap = kind === "management_attribution"
      ? undefined
      : requestedMetrics(item.text).find((metric) => packet.unavailable_metrics?.includes(metric.label))?.label;
    if (gap !== undefined) {
      reject(index, item, `${gap} is not in the evidence: it is a named gap`);
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
    // A comparison's claimed result is derived from its complete eligible
    // evidence before it may stand (comparisons.ts).
    const comparison = kind === "comparison" ? checkComparison(item, figureIds, packet) : undefined;
    if (comparison && "error" in comparison) {
      reject(index, item, comparison.error);
      continue;
    }
    accepted.push({
      index,
      kind,
      text: item.text,
      evidence,
      ...(kind === "analyst_inference" ? { supports } : {}),
      ...(kind === "comparison" ? { op: item.op as ComparisonOp, result: item.result as string | string[] } : {}),
    });
  }
  accepted.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);
  return { status: "checked", accepted, rejected, ...(unchecked > 0 ? { unchecked } : {}) };
}

// An inference's supports, when the observations cannot be figure-checked:
// at least one, each an observation that passed every check it could take.
function restsOnObservations(supports: unknown, observations: ReadonlySet<number>): boolean {
  return Array.isArray(supports) && supports.length > 0 && supports.every((n) => observations.has(n as number));
}

// A year said as a time: after a preposition of time or a month ("since
// 2025", "in Feb 2026"); a bare "2025 employees", or one after "to" or "of"
// ("grew to 2025"), is a figure.
const TIME_BEFORE = new RegExp(String.raw`(?:\b(?:in|since|from|by|through|until|during|before|after|fiscal(?: year)?|calendar(?: year)?)|\b(?:${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].join("|")})[a-z]*\.?)\s+$`, "i");

// A figure's value in the text: a number other than a year said as a time or
// a period's ("FY2025", "Q3"). A rendered inference may state none (#208).
export function statesValue(text: string, companies: ReadonlyArray<string>): boolean {
  // A company's name is not a value, even with digits in it ("3M").
  const masked = withoutCompanies(text, companies);
  return quantities(masked).some((quantity) => !quantity.period && !(
    /^\d{4}$/.test(quantity.value) && !quantity.unit && !quantity.currency && !quantity.negative && !quantity.positive &&
    TIME_BEFORE.test(masked.slice(0, quantity.at))
  ));
}

// Every cited figure: the template says each cited metric changed. The
// other period may be any shown, so the figure that moved alone will do.
// Each figure value an inference states, bound to the one cited figure it is
// (its fact): where it sits in the text, so it can render as a fact ref.
// Null when a value binds to no cited figure or to several different facts.
export function linkFigures(
  text: string,
  cited: ReadonlyArray<string>,
  packet: EvidencePacket,
): Array<{ at: number; length: number; figureId: string }> | null {
  const figures = packet.figures.filter((figure) => cited.includes(figure.id));
  const companyOf = (company: string | undefined) => company ?? packet.companies[0];
  const prefixes = currencyPrefixes(packet);
  const masked = withoutCompanies(text, packet.companies);
  const links: Array<{ at: number; length: number; figureId: string }> = [];
  for (const quantity of quantities(masked, prefixes)) {
    // A period's number ("Q4") or a year said as a time ("Q1 2026", "through
    // 2025") is never a value to link; a grouped "2,025" is a quantity.
    if (quantity.period) continue;
    if (/^\d{4}$/.test(quantity.raw) && (TIME_BEFORE.test(masked.slice(0, quantity.at)) || /\b(?:Q[1-4]|H[12]|FY)\s*$/.test(masked.slice(0, quantity.at)))) continue;
    const named = companyAfter(text, quantity.at + quantity.raw.length, packet.companies) ?? lastCompanyBefore(text, quantity.at, packet.companies);
    const matches = figures.filter((figure) =>
      (named === undefined || companyOf(figure.company) === named) &&
      quantities(figure.value, prefixes).some((shown) => sameQuantity(quantity, shown))
    );
    const facts = new Set(matches.map((figure) => figure.fact_id ?? figure.id));
    if (facts.size !== 1) return null;
    // Accounting parentheses are outside the match.
    const length = quantity.raw.startsWith("(") ? quantity.raw.length - 2 : quantity.raw.length;
    links.push({ at: quantity.at, length, figureId: matches[0]!.id });
  }
  return links;
}

function showsChange(cited: ReadonlyArray<EvidencePacket["figures"][number]>, shown: EvidencePacket["figures"]): boolean {
  return cited.length > 0 && cited.every((a) => shown.some((b) =>
    a.company === b.company && a.metric === b.metric && a.segment === b.segment && a.period !== undefined && b.period !== undefined &&
    a.period.replace(/\s+/g, "") !== b.period.replace(/\s+/g, "") && a.value !== b.value
  ));
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
    case "comparison":
      return figureIds.length < 2 || claimIds.length > 0 ? "a comparison cites two or more figures, and only figures" : null;
    case "unknown_cause":
      return figureIds.length === 0 || claimIds.length > 0 ? "an unknown cause cites the figures that changed, and no claim" : null;
    case "management_attribution":
      return claimIds.length === 0 || figureIds.length > 0 ? "a management attribution cites the claim that makes it, and only claims" : null;
    case "analyst_inference": {
      const observations = new Set(accepted.filter((entry) => entry.kind === "observation" || entry.kind === "comparison").map((entry) => entry.index));
      return !supports.some((n) => observations.has(n))
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
  // Each candidate keeps its role: a figure's value, its period, or a claim's
  // number. A period's number in the text ("Q4") binds only a period.
  const sources = [
    ...figures.flatMap((figure) => [
      { source: figure.value, role: "value" },
      { source: figure.period ?? "", role: "period" },
      { source: figure.period_end?.slice(0, 4) ?? "", role: "period" },
    ].map((entry) => ({ ...entry, company: companyOf(figure.company) }))),
    ...claims.flatMap((claim) => [
      { source: claim.text, role: "claim" },
      { source: claim.effective_time?.slice(0, 4) ?? "", role: "period" },
      { source: claim.published_at?.slice(0, 4) ?? "", role: "period" },
    ].map((entry) => ({ ...entry, company: claim.company }))),
  ];
  const prefixes = currencyPrefixes(packet);
  // A stored quarter ("Q42026") reads as prose writes it ("Q4 2026").
  const evidence = sources.flatMap(({ source, role, company }) =>
    quantities(source.replace(/\bQ([1-4])(?=\d{4}\b)/g, "Q$1 "), prefixes).map((quantity) => ({ quantity, role, company }))
  );
  // Evidence spanning companies leaves a value's company to its phrasing; one
  // with no company named before it (or right after it, "for AMD") is unbound
  // rather than guessed ("75.0% was AMD's margin").
  const spans = new Set(evidence.flatMap((entry) => (entry.company ? [entry.company] : []))).size > 1;
  // A company's name is not a value, even with digits in it ("3M Company").
  for (const quantity of quantities(withoutCompanies(text, packet.companies), prefixes)) {
    // A period's number ("Q3") binds only a period: a figure's, a claim's
    // dates, or one a claim's text writes as a period.
    const candidates = evidence.filter((entry) => sameQuantity(quantity, entry.quantity) &&
      (!quantity.period || entry.role === "period" || (entry.role === "claim" && entry.quantity.period)));
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
  // A month the text dates something by is a cited date's: a claim's, the
  // month a figure's period ends in, or a date its window names ("YTD 2026:
  // 2025-12-31 close to ...").
  const months = new Set([
    ...claims.flatMap((claim) => [claim.effective_time, claim.published_at]),
    ...figures.flatMap((figure) => [figure.period_end, ...(figure.period?.match(/\d{4}-\d{2}-\d{2}/g) ?? [])]),
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
const MONTH_YEAR = new RegExp(`\\b(${MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)}${month === "September" ? "|t" : ""})?`).join("|")})\\.?\\s+(\\d{4})\\b`, "gi");

function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

// currency: its prefix as written ("$", "€", "CN¥"), "" for none.
// period: written as a period's number ("Q4", "FY2026", "H1").
type Quantity = { raw: string; at: number; value: string; unit: string; currency: string; negative: boolean; positive: boolean; period: boolean };

// Numbers with their sign, currency prefix and unit; the value compared as a number,
// so "75%" is the "75.0%" shown while "7.5" is not "75". A currency prefix is
// any with a currency symbol ("$", "₹", "CN¥") or a letter prefix the packet's
// figures are written with ("CHF 3.1B", "F CFA 3.1B"); letters alone are never
// taken for one otherwise, so "FY 2026" is not a currency.
// A denomination after a magnitude ("75 million dollars") is its currency.
const DENOMINATIONS: Readonly<Record<string, string>> = { dollar: "$", euro: "€", pound: "£", yen: "¥", yuan: "CN¥", rupee: "₹", franc: "CHF" };
const DENOMINATION = String.raw`(?:[Dd]ollars?|[Ee]uros?|[Pp]ounds?|[Yy]en|[Yy]uan|[Rr]upees?|[Ff]rancs?)\b`;
// Units written as words ("75 dollars", "75 shares"): stated, so never taken
// for an omitted unit; no figure is formatted with one, so none matches
// (except "times", which is the "x" a multiple is shown with).
const WORDED = String.raw`(?:[Dd]ollars?|[Ee]uros?|[Pp]ounds?|[Yy]en|[Yy]uan|[Ff]rancs?|[Rr]upees?|[Ss]hares?|[Uu]nits?|[Tt]imes)\b`;
// Case-sensitive, so a currency code is never a word ("top 3" is not TOP).
const UNIT = String.raw`%|x\b|×|[KMBTkmbt]\b|[Bb]n\b|[Mm]n\b|[Tt]housand\b|[Mm]illion\b|[Bb]illion\b|[Tt]rillion\b|[Bb]asis points?\b|bps?\b|[Pp]ercentage points?\b|pp\b|[Pp]ercent\b|[Pp]er cent\b|${WORDED}`;
// Every ISO currency code ("USD 3.1B"), so one the evidence lacks is a mismatch.
const ISO_CODES = String.raw`(?<![A-Za-z])(?:${Intl.supportedValuesOf("currency").join("|")})(?=${"[ \u00a0\u202f]"}?[\d.])`;
const SPACE = String.raw`[ \u00a0\u202f]`;

function quantityPattern(prefixes: ReadonlyArray<string>): RegExp {
  const known = [...prefixes].sort((a, b) => b.length - a.length)
    .map((prefix) => `(?<![A-Za-z])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, SPACE)}`);
  const currency = [...known, ISO_CODES, String.raw`(?:(?<![A-Za-z])[A-Z]{1,2})?\p{Sc}`].join("|");
  // A sign may stand apart from a currency prefix ("- $75B"), never from bare
  // digits (a list's "- 3.1%").
  return new RegExp(String.raw`(?<![\d.])(?:([-−+])(?:${SPACE}(?=${currency.replace(/\(\?<!\[A-Za-z\]\)/g, "")}))?)?((?:${currency})${SPACE}?)?(\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:\s*(${UNIT}))?(?:\s+(${DENOMINATION}))?`, "gu");
}

// The currency prefixes a packet's figures are written with: whatever stands
// between a value's sign and its digits.
function currencyPrefixes(packet: EvidencePacket): string[] {
  return [...new Set(packet.figures.flatMap((figure) => {
    const prefix = /^[-−]?(\D*?)\s*[\d.]/.exec(figure.value)?.[1]?.trim();
    return prefix ? [prefix] : [];
  }))];
}

const UNITS: Readonly<Record<string, string>> = {
  thousand: "K", million: "M", mn: "M", billion: "B", bn: "B", trillion: "T",
  "basis point": "bp", "basis points": "bp", bp: "bp", bps: "bp",
  "percentage point": "pt", "percentage points": "pt", pp: "pt",
  percent: "%", "per cent": "%",
  times: "x",
};

function quantities(text: string, prefixes: ReadonlyArray<string> = []): Quantity[] {
  return [...text.matchAll(quantityPattern(prefixes))].map((match) => {
    const unit = (match[4] ?? "").toLowerCase();
    const denomination = DENOMINATIONS[(match[5] ?? "").toLowerCase().replace(/s$/, "")];
    const currency = (match[2] ?? "").trim().replace(/\s+/g, " ").replace(/^US\$$/, "$") || denomination || "";
    // Accounting parentheses ("($3.1B)") make an amount negative; a percentage
    // in parentheses is prose's aside ("gross margin (75.0%)").
    const parenthesized = currency !== "" &&
      /\(\s*$/.test(text.slice(0, match.index)) && /^\s*\)/.test(text.slice(match.index + match[0].length));
    return {
      raw: parenthesized ? `(${match[0].trim()})` : match[0].trim(),
      at: match.index,
      value: String(Number(match[3]!.replace(/,/g, ""))),
      unit: UNITS[unit] ?? (unit === "%" || unit === "x" ? unit : unit === "×" ? "x" : unit.toUpperCase()),
      currency,
      negative: parenthesized || (match[1] !== undefined && match[1] !== "+"),
      positive: match[1] === "+",
      period: /(?:\bQ|\bFY ?|\bH)$/.test(text.slice(0, match.index)),
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

// The text with each company's name blanked to spaces, keeping offsets.
function withoutCompanies(text: string, companies: ReadonlyArray<string>): string {
  return companies.reduce((masked, company) => {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return masked.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), (name) => " ".repeat(name.length));
  }, text);
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
