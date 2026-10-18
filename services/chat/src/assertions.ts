// Evidence-bound assertions (#208): the answer model lists what its answer
// asserts, each classified and citing evidence_packet ids ("F2", "C1").
// Company, metric, period and value come from the cited packet entries, never
// typed by the model, so a binding cannot name the wrong company or scale; the
// check here is that every id exists, that each kind cites what it must, and
// that each reference the text writes ([[F3]], prose-refs.ts) is its evidence's.
// Only an analyst inference's text is shown: every other kind is rendered from
// its evidence in a template (render-assertions.ts), so its words are not read.
// An analyst inference writes no figure at all: it says in words what the
// observations, comparisons and attributions it rests on mean, so every figure
// a rendered answer shows is a template's value from the packet. What the data
// cannot show is the packet's to say, in its gap notes, never the model's (#302).
//
// The answer is written from the accepted assertions (render-assertions.ts),
// and the report goes to evals and logs.

import { checkComparison, comparablePeriods, type ComparisonOp } from "./comparisons.ts";
import type { EvidencePacket } from "./evidence-packet.ts";
import { REFERENCE } from "./prose-refs.ts";
import { requestedMetrics } from "./research-scope.ts";

export const ASSERTION_KINDS = ["observation", "comparison", "management_attribution", "analyst_inference", "unknown_cause"] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export type Assertion = {
  kind: AssertionKind;
  text: string;
  evidence: ReadonlyArray<string>;
  // An inference's supporting observations, comparisons and management
  // attributions, by their index in the list.
  supports?: ReadonlyArray<number>;
  // The company an inference is about, one its evidence covers: across
  // companies its text names none, so the label names it (#308).
  subject?: string;
  // A comparison's operation and claimed result (comparisons.ts): the high or
  // low's id, the ids highest first, or a trend's result.
  op?: ComparisonOp;
  result?: string | ReadonlyArray<string>;
};

export type AssertionReport = {
  // missing: the answer listed none; malformed: the list did not parse;
  // skipped: no figures or claims, so there was nothing to bind.
  status: "missing" | "malformed" | "checked" | "skipped";
  accepted: ReadonlyArray<Assertion & { index: number }>;
  rejected: ReadonlyArray<Rejection>;
  // The answer was written from the accepted assertions (controlled rendering).
  rendered?: boolean;
  // Accepted observations the rendered answer leaves out, since a comparison
  // it shows writes every figure they state.
  repeated?: ReadonlyArray<number>;
};

// The answer is rendered from this list (#208), so it holds a comparison
// answer's observations, a comparison per metric, the takeaway and the
// counterpoint; at 8, counterpoints fell past the cap (2026-10-13 eval).
export const MAX_ASSERTIONS = 12;

// The check a rejection failed, named so a report can tell a wrong number or
// citation (binding) from a wrong ranking or trend (comparative), and so a
// held-out mutation fails one named check (#221).
export type RejectionCheck =
  | "binding" | "comparative" | "reference" | "kind" | "support" | "gap" | "limit" | "format" | "rendering";
export type Rejection = { index: number; text?: string; check: RejectionCheck; reason: string };

// The list closes the answer in a fenced block, closed or not (a reply cut
// off inside it). The first block is the one read, so a second (a corrected
// list) is not.
const FENCE = /```assertions[ \t]*\r?\n([\s\S]*?)(?:```|$)/;

// The answer's assertion list as written: undefined when there is none; null
// when it does not parse.
export function assertionList(text: string): unknown[] | null | undefined {
  const written = FENCE.exec(text)?.[1];
  if (written === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(written);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function checkAssertions(list: unknown[] | null | undefined, packet: EvidencePacket): AssertionReport {
  if (packet.figures.length === 0 && packet.claims.length === 0) return { status: "skipped", accepted: [], rejected: [] };
  if (list === undefined) return { status: "missing", accepted: [], rejected: [] };
  if (list === null) return { status: "malformed", accepted: [], rejected: [] };
  const figures = new Map(packet.figures.map((figure) => [figure.id, figure]));
  const claims = new Map(packet.claims.map((claim) => [claim.id, claim]));
  const accepted: Array<Assertion & { index: number }> = [];
  const rejected: Rejection[] = [];
  const reject = (index: number, item: unknown, check: RejectionCheck, reason: string) =>
    rejected.push({ index, ...(isRecord(item) && typeof item.text === "string" ? { text: item.text } : {}), check, reason });

  // Inferences last, so the observations they rest on are already checked.
  const order = list.map((item, index) => ({ item, index }))
    .sort((a, b) => Number(kindOf(a.item) === "analyst_inference") - Number(kindOf(b.item) === "analyst_inference"));
  for (const { item, index } of order) {
    if (index >= MAX_ASSERTIONS) {
      reject(index, item, "limit", `more than ${MAX_ASSERTIONS} assertions`);
      continue;
    }
    if (!isRecord(item) || typeof item.text !== "string" || item.text.trim() === "") {
      reject(index, item, "format", "not an assertion with text");
      continue;
    }
    const kind = kindOf(item);
    if (kind === undefined) {
      reject(index, item, "format", `unknown kind ${JSON.stringify(item.kind)}`);
      continue;
    }
    // A malformed list is the model's error to report, never cleaned up. An
    // inference cites through its supports, so its evidence may be left out.
    const listed = item.evidence === undefined && kind === "analyst_inference" ? [] : item.evidence;
    if (!Array.isArray(listed) || !listed.every((id) => typeof id === "string")) {
      reject(index, item, "reference", "evidence is not a list of packet ids");
      continue;
    }
    if (item.supports !== undefined && kind !== "analyst_inference") {
      reject(index, item, "format", "only an analyst inference lists supports");
      continue;
    }
    if (item.subject !== undefined && kind !== "analyst_inference") {
      reject(index, item, "format", "only an analyst inference has a subject");
      continue;
    }
    if ((item.op !== undefined || item.result !== undefined) && kind !== "comparison") {
      reject(index, item, "format", "only a comparison has an op and a result");
      continue;
    }
    if (item.supports !== undefined && (!Array.isArray(item.supports) || !item.supports.every((n) => Number.isInteger(n)))) {
      reject(index, item, "format", "supports is not a list of assertion indexes");
      continue;
    }
    const evidence = listed as string[];
    const twice = evidence.find((id, i) => evidence.indexOf(id) !== i);
    if (twice !== undefined) {
      reject(index, item, "reference", `evidence lists ${JSON.stringify(twice)} twice`);
      continue;
    }
    const unknown = evidence.find((id) => !figures.has(id) && !claims.has(id));
    if (unknown !== undefined) {
      reject(index, item, "reference", `unknown evidence id ${JSON.stringify(unknown)}`);
      continue;
    }
    // An inference writes no digit at all, a period's included: the periods
    // are its supports', rendered from the packet beside it.
    if (kind === "analyst_inference" && (/\p{N}/u.test(item.text) || AMOUNT_WORD.test(item.text))) {
      reject(index, item, "binding", "an inference rests on its supports; it writes no figure");
      continue;
    }
    // Across companies, who leads or trails is its comparisons' checked
    // result, rendered in its label; its words name none, so they cannot
    // contradict it ("AMD leads" beside a checked NVDA-highest, #288).
    // A one-letter ticker ("A") cannot be told from the article, as in the guard.
    if (kind === "analyst_inference" && packet.companies.length > 1 &&
      packet.companies.some((company) => company.length > 1 && mentions(item.text as string, company))) {
      reject(index, item, "binding", "an inference names no company; its subject does");
      continue;
    }
    const figureIds = evidence.filter((id) => figures.has(id));
    const claimIds = evidence.filter((id) => claims.has(id));
    // A support that failed its own check is dropped; the inference stands on
    // the rest. A claim it relies on is a support too ("given the charge
    // management disclosed"), so the judge reads it beside the inference.
    const supports = ((item.supports ?? []) as number[]).filter((n) =>
      accepted.some((entry) => entry.index === n && SUPPORT_KINDS.has(entry.kind))
    );
    const shape = shapeError(kind, figureIds, claimIds, supports);
    if (shape) {
      reject(index, item, shape.check, shape.reason);
      continue;
    }
    // An unknown cause is a change's: each figure it cites has its company's
    // same metric in another period with a different value beside it.
    if (kind === "unknown_cause" && !showsChange(figureIds.map((id) => figures.get(id)!), packet.figures)) {
      reject(index, item, "kind", "an unknown cause cites a change: one company's metric, two periods, two values");
      continue;
    }
    // Read with the question's own metric names, so "FCF" is free cash flow.
    const gap = kind === "analyst_inference"
      ? requestedMetrics(item.text).find((metric) => packet.unavailable_metrics?.includes(metric.label))?.label
      : undefined;
    if (gap !== undefined) {
      reject(index, item, "gap", `${gap} is not in the evidence: it is a named gap`);
      continue;
    }
    // An inference's evidence is its own plus that of the observations it rests on.
    const cited = kind === "analyst_inference"
      ? [...evidence, ...accepted.filter((entry) => supports.includes(entry.index)).flatMap((entry) => entry.evidence)]
      : evidence;
    const binding = bindingError(kind, item.text, cited, packet);
    if (binding) {
      reject(index, item, binding.check, binding.reason);
      continue;
    }
    if (item.subject !== undefined &&
      (typeof item.subject !== "string" || !packet.companies.includes(item.subject) || !companiesOf(cited, packet).has(item.subject))) {
      reject(index, item, "binding", "an inference's subject is a company its evidence covers");
      continue;
    }
    // A comparison's claimed result is derived from its complete eligible
    // evidence before it may stand (comparisons.ts).
    const comparison = kind === "comparison" ? checkComparison(item, figureIds, packet) : undefined;
    if (comparison && "error" in comparison) {
      reject(index, item, "comparative", comparison.error);
      continue;
    }
    accepted.push({
      index,
      kind,
      text: item.text,
      evidence,
      ...(kind === "analyst_inference" ? { supports, ...(item.subject !== undefined ? { subject: item.subject as string } : {}) } : {}),
      ...(kind === "comparison" ? { op: item.op as ComparisonOp, result: item.result as string | string[] } : {}),
    });
  }
  accepted.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);
  return { status: "checked", accepted, rejected };
}

const SUPPORT_KINDS: ReadonlySet<AssertionKind> = new Set(["observation", "comparison", "management_attribution"]);

// An amount in words: a number word, then a unit ("seventy percent", "a few
// billion dollars"). An inference states none. A count ("three companies") or
// a unit with no number ("per dollar of revenue") is not an amount.
const NUMBER_WORD = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|dozen|few|several|half)`;
const AMOUNT_UNIT = String.raw`(?:per ?cent|percent(?:age points?)?|basis points?|bps|points?|dollars?|cents?|euros?|pounds?|pence|yen|yuan|renminbi|francs?|rupees?|thousands?|millions?|billions?|trillions?)`;
// "a billion dollars": an article counts as a number only before a scale.
const AMOUNT_WORD = new RegExp(String.raw`\b(?:${NUMBER_WORD}(?:[- ]${NUMBER_WORD})*[- ]${AMOUNT_UNIT}|an? (?:hundred|thousand|million|billion|trillion))\b`, "i");

// Every cited figure: the template says each cited metric changed. The
// other period may be any shown, so the figure that moved alone will do.
function showsChange(cited: ReadonlyArray<EvidencePacket["figures"][number]>, shown: EvidencePacket["figures"]): boolean {
  return cited.length > 0 && cited.every((a) => shown.some((b) =>
    a.company === b.company && a.metric === b.metric && a.segment === b.segment && a.period !== undefined && b.period !== undefined &&
    a.period.replace(/\s+/g, "") !== b.period.replace(/\s+/g, "") && a.value !== b.value && comparablePeriods(a, b)
  ));
}

// What each kind must cite.
// ponytail: a management attribution needs a claim, not proof that the claim
// states that cause; that is judged by the held-out evaluation (#221).
function shapeError(
  kind: AssertionKind,
  figureIds: ReadonlyArray<string>,
  claimIds: ReadonlyArray<string>,
  // An inference's accepted supports.
  supports: ReadonlyArray<number>,
): Pick<Rejection, "check" | "reason"> | null {
  const cites = (reason: string) => ({ check: "kind" as const, reason });
  switch (kind) {
    case "observation":
      return figureIds.length === 0 || claimIds.length > 0 ? cites("an observation cites figures, and only figures") : null;
    case "comparison":
      return figureIds.length < 2 || claimIds.length > 0 ? cites("a comparison cites two or more figures, and only figures") : null;
    case "unknown_cause":
      return figureIds.length === 0 || claimIds.length > 0 ? cites("an unknown cause cites the figures that changed, and no claim") : null;
    case "management_attribution":
      return claimIds.length === 0 || figureIds.length > 0 ? cites("a management attribution cites the claim that makes it, and only claims") : null;
    case "analyst_inference":
      return supports.length === 0 ? { check: "support", reason: "an inference binds the accepted observations it rests on" } : null;
  }
}

function bindingError(kind: AssertionKind, text: string, cited: ReadonlyArray<string>, packet: EvidencePacket): Pick<Rejection, "check" | "reason"> | null {
  for (const [reference, id] of text.matchAll(REFERENCE)) {
    if (!packet.figures.some((figure) => figure.id === id) && !packet.claims.some((claim) => claim.id === id)) return { check: "reference", reason: `unknown reference ${reference}` };
    if (!cited.includes(id!)) return { check: "binding", reason: `${reference} is not in its evidence` };
  }
  if (kind !== "analyst_inference") return null;
  // A claim with no company is no company's (its record named none).
  if (packet.claims.some((claim) => cited.includes(claim.id) && claim.company === undefined)) return null;
  const own = companiesOf(cited, packet);
  // A one-letter ticker ("A") cannot be told from the article, as in the guard.
  const other = packet.companies.find((company) => company.length > 1 && !own.has(company) && mentions(text, company));
  return other === undefined ? null : { check: "binding", reason: `names ${other}, which its evidence does not` };
}

// The companies cited figures and claims are about; a figure with no company
// is the only company's.
export function companiesOf(cited: ReadonlyArray<string>, packet: EvidencePacket): Set<string | undefined> {
  return new Set([
    ...packet.figures.filter((figure) => cited.includes(figure.id)).map((figure) => figure.company ?? packet.companies[0]),
    ...packet.claims.filter((claim) => cited.includes(claim.id)).map((claim) => claim.company),
  ]);
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
