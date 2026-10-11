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
  // missing: the answer listed none; malformed: the list did not parse.
  status: "missing" | "malformed" | "checked";
  accepted: ReadonlyArray<Assertion & { index: number }>;
  rejected: ReadonlyArray<{ index: number; text?: string; reason: string }>;
};

export const MAX_ASSERTIONS = 8;

// The list closes the answer in a fenced block the reader never sees. Wherever
// it is, and closed or not, it is cut from the prose.
const FENCE = /```assertions[ \t]*\n([\s\S]*?)(?:```|$)/;

// The prose without its assertion list, and the list as written (undefined when
// there is none; null when it does not parse).
export function splitAssertions(text: string): { prose: string; list: unknown[] | null | undefined } {
  const match = FENCE.exec(text);
  if (!match) return { prose: text, list: undefined };
  const prose = `${text.slice(0, match.index).trimEnd()}\n\n${text.slice(match.index + match[0].length).trimStart()}`.trim();
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    return { prose, list: Array.isArray(parsed) ? parsed : null };
  } catch {
    return { prose, list: null };
  }
}

export function checkAssertions(list: unknown[] | null | undefined, packet: EvidencePacket): AssertionReport {
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
    const evidence = Array.isArray(item.evidence) ? item.evidence.filter((id): id is string => typeof id === "string") : [];
    const unknown = evidence.find((id) => !figures.has(id) && !claims.has(id));
    if (unknown !== undefined) {
      reject(index, item, `unknown evidence id ${JSON.stringify(unknown)}`);
      continue;
    }
    const figureIds = evidence.filter((id) => figures.has(id));
    const claimIds = evidence.filter((id) => claims.has(id));
    const supports = Array.isArray(item.supports) ? item.supports.filter((n): n is number => Number.isInteger(n)) : [];
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
  return { status: "checked", accepted, rejected };
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

// Every number and company the text states must be its evidence's: a cited
// figure's value, period or metric, or a cited claim's text and dates.
function bindingError(text: string, cited: ReadonlyArray<string>, packet: EvidencePacket): string | null {
  const figures = packet.figures.filter((figure) => cited.includes(figure.id));
  const claims = packet.claims.filter((claim) => cited.includes(claim.id));
  const sources = [
    ...figures.flatMap((figure) => [figure.value, figure.period ?? "", figure.metric, figure.period_end?.slice(0, 4) ?? ""]),
    ...claims.flatMap((claim) => [claim.text, claim.effective_time?.slice(0, 4) ?? "", claim.published_at?.slice(0, 4) ?? ""]),
  ];
  const allowed = new Set(sources.flatMap(numbers));
  const stray = numbers(text).find((number) => !allowed.has(number));
  if (stray !== undefined) return `${stray} is not in its evidence`;
  // A figure or claim with no company is the only company's.
  const own = new Set([
    ...figures.map((figure) => figure.company ?? packet.companies[0]),
    ...claims.map((claim) => claim.company ?? packet.companies[0]),
  ]);
  const other = packet.companies.find((company) => !own.has(company) && mentions(text, company));
  return other === undefined ? null : `names ${other}, which its evidence does not`;
}

// By value, so "75%" is the "75.0%" shown, while "7.5" is not "75".
function numbers(text: string): string[] {
  return (text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map((number) => String(Number(number.replace(/,/g, ""))));
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
