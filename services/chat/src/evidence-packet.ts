// The evidence an answer is written from (#207): the turn's route and cutoff,
// each figure shown with a short packet id bound to its fact and sources,
// which companies have figures and which do not, what could not be shown, and
// the bounds the readers applied. Built from the deterministic fact blocks
// and the turn's research scope, never from raw tool results.
//
// The model sees short ids ("F1", "C1"); the fact, claim and source ids stay
// here, so the prompt stays compact (#181) and an assertion citing one can be
// bound back to its record (#208).
//
// Claims are the route's selection (claimSelection, loaded with the turn's
// cutoff): repeats already counted once, each placed by its stored polarity,
// with any stored contradiction between them named.

import { displayedFigures, QUARTERS_SHOWN, type DisplayedFigure } from "./fact-blocks.ts";
import type { ResearchScope } from "./research-scope.ts";

type Block = Record<string, unknown>;

export type PacketFigure = Omit<DisplayedFigure, "fact_id" | "block_id"> & {
  id: string;
  fact_id?: string;
  source_ids: ReadonlyArray<string>;
};

// A claim as the evidence loader returns it (local-runtime-evidence.ts).
export type ClaimRecord = {
  claim_id: string;
  source_id: string;
  text_canonical: string;
  predicate: string;
  polarity: string;
  effective_time: string | null;
  published_at: string | null;
  subject_id?: string;
};

export type ClaimEvidence = {
  claims: ReadonlyArray<ClaimRecord>;
  truncated?: boolean;
  contradictions?: ReadonlyArray<readonly [string, string]>;
  // The claims read failed: they are unavailable, never "none on file".
  unavailable?: boolean;
};

export type PacketClaim = {
  id: string;
  text: string;
  predicate: string;
  // Placed only by the claim's stored polarity: positive supports the
  // company's case, negative challenges it, mixed is unclassified.
  stance: "supporting" | "challenging" | "neutral" | "unclassified";
  company?: string;
  effective_time?: string;
  published_at?: string;
  claim_id: string;
  source_id: string;
};

export type EvidencePacket = {
  route: string;
  cutoff: string;
  companies: ReadonlyArray<string>;
  figures: ReadonlyArray<PacketFigure>;
  // Each company the turn covers: shown when the answer has a figure for it.
  coverage: ReadonlyArray<{ company: string; status: "shown" | "not_shown" }>;
  // What could not be shown, as the gap notes say it.
  gaps: ReadonlyArray<string>;
  query_bounds: Readonly<Record<string, string>>;
  claims: ReadonlyArray<PacketClaim>;
  // Claims that may disagree, by packet id, and why.
  disagreements: ReadonlyArray<{ claims: readonly [string, string]; basis: string }>;
  claims_status: "available" | "none" | "unavailable";
  claims_truncated: boolean;
  // Metrics the question asked for that no reader serves (#206): named gaps
  // no other figure may stand in for (#208).
  unavailable_metrics?: ReadonlyArray<string>;
};

// The claims a route reads first (#207): its predicate families, from the
// start of the period it covers. Others still fill any room left, newest first.
const ROUTE_PREDICATES: Partial<Record<ResearchScope["reads"], ReadonlyArray<string>>> = {
  latest_quarter: ["guidance.", "kpi."],
  trend: ["guidance.", "kpi."],
  derived_margin: ["guidance.", "kpi."],
  comparison: ["guidance.", "kpi."],
  segments: ["segment.", "guidance."],
};
const PRICE_PREDICATES = ["material_event.", "guidance."];

export function claimSelection(
  scope: ResearchScope | undefined,
  cutoff: string,
): { predicate_prefixes: ReadonlyArray<string>; effective_from: string | null } {
  if (!scope) return { predicate_prefixes: [], effective_from: null };
  const route = ROUTE_PREDICATES[scope.reads] ?? [];
  // A price window adds the events that move a price, whatever else is read.
  const prefixes = [...new Set([...route, ...(scope.price_window ? PRICE_PREDICATES : [])])];
  return { predicate_prefixes: prefixes, effective_from: periodStart(scope, cutoff, route.length > 0) };
}

// ponytail: calendar approximations of the readers' periods; a fiscal year is
// widened by a year so one ending mid-year still covers its claims. One window
// for every predicate: the route's period, which covers a year-to-date window.
function periodStart(scope: ResearchScope, cutoff: string, routed: boolean): string | null {
  if (scope.fiscal_year !== null) return `${scope.fiscal_year - 1}-01-01T00:00:00.000Z`;
  if (scope.price_window && !routed) return `${cutoff.slice(0, 4)}-01-01T00:00:00.000Z`;
  const start = new Date(cutoff);
  if (Number.isNaN(start.getTime())) return null;
  start.setUTCMonth(start.getUTCMonth() - 3 * QUARTERS_SHOWN);
  return start.toISOString();
}

export function buildEvidencePacket(input: {
  scope?: ResearchScope;
  factBlocks: ReadonlyArray<Block>;
  cutoff: string;
  claims?: ClaimEvidence;
}): EvidencePacket {
  const blockSources = new Map(input.factBlocks.flatMap((block) =>
    typeof block.id === "string" ? [[block.id, sourceIds(block)] as const] : []
  ));
  const figures = displayedFigures(input.factBlocks).map(({ fact_id, block_id, ...figure }, index) => ({
    id: `F${index + 1}`,
    ...figure,
    ...(fact_id ? { fact_id } : {}),
    source_ids: (block_id && blockSources.get(block_id)) || [],
  }));
  // Every company the scope covers, whether or not a block shows it. An
  // auto-selected peer carries no label in the scope: the comparison names it,
  // and without one it is still covered, by issuer.
  const blockLabels = new Map(input.factBlocks.flatMap((block) => {
    const subjects = Array.isArray(block.subjects) ? block.subjects : [];
    const labels = Array.isArray(block.subject_labels) ? block.subject_labels : [];
    return subjects.flatMap((subject, index) =>
      isRecord(subject) && isString(subject.id) && isString(labels[index]) ? [[subject.id, labels[index]] as const] : []
    );
  }));
  const scopeLabels = new Map((input.scope?.companies ?? []).map((company) => [
    company.issuer_id,
    company.label ?? blockLabels.get(company.issuer_id) ?? `issuer:${company.issuer_id.slice(0, 8)}`,
  ]));
  const companies = unique([
    ...scopeLabels.values(),
    ...input.factBlocks.flatMap((block) => Array.isArray(block.subject_labels) ? block.subject_labels.filter(isString) : []),
  ]);
  // A single company's figures name no company: they are all its own.
  const shown = (company: string) =>
    figures.some((figure) => figure.company === company) ||
    (companies.length === 1 && figures.length > 0);
  return {
    route: input.scope?.route ?? "unknown",
    cutoff: input.cutoff,
    companies,
    figures,
    coverage: companies.map((company) => ({ company, status: shown(company) ? "shown" : "not_shown" })),
    gaps: input.factBlocks.flatMap((block) =>
      block.kind === "rich_text" && Array.isArray(block.segments)
        ? block.segments.flatMap((segment) => (isRecord(segment) && isString(segment.text) ? [segment.text] : []))
        : []
    ),
    query_bounds: {
      ...(input.scope ? queryBounds(input.scope) : {}),
      ...(input.claims ? { claims: claimBounds(input.scope, input.cutoff) } : {}),
    },
    // A claim names its company as coverage does; one matched outside the
    // scope by the block's label.
    ...packetClaims(input.claims, (issuer) => scopeLabels.get(issuer) ?? blockLabels.get(issuer)),
    ...(input.scope?.metrics.some((metric) => !metric.available)
      ? { unavailable_metrics: input.scope.metrics.filter((metric) => !metric.available).map((metric) => metric.label) }
      : {}),
  };
}

function packetClaims(
  evidence: ClaimEvidence | undefined,
  companyOf: (issuer: string) => string | undefined,
): Pick<EvidencePacket, "claims" | "disagreements" | "claims_status" | "claims_truncated"> {
  const records = evidence?.claims ?? [];
  const label = (issuer: string | undefined) => (issuer === undefined ? undefined : companyOf(issuer));
  const claims: PacketClaim[] = records.map((record, index) => {
    const company = label(record.subject_id);
    return {
      id: `C${index + 1}`,
      text: record.text_canonical,
      predicate: record.predicate,
      stance: STANCE[record.polarity] ?? "unclassified",
      ...(company ? { company } : {}),
      ...(record.effective_time ? { effective_time: record.effective_time } : {}),
      ...(record.published_at ? { published_at: record.published_at } : {}),
      claim_id: record.claim_id,
      source_id: record.source_id,
    };
  });
  const packetId = new Map(claims.map((claim) => [claim.claim_id, claim.id]));
  // Only a stored relation: a claim records no metric or value, so opposite
  // directions ("raised revenue guidance", "lowered EPS guidance") can both be
  // true. Each pair in packet order (C1 before C2), however it is listed.
  const byIndex = (x: string, y: string) => Number(x.slice(1)) - Number(y.slice(1));
  const disagreements = [...new Map((evidence?.contradictions ?? []).flatMap(([a, b]) => {
    const ids = [packetId.get(a), packetId.get(b)];
    if (!ids[0] || !ids[1] || ids[0] === ids[1]) return [];
    const pair = (ids as string[]).sort(byIndex) as [string, string];
    return [[pair.join(), { claims: pair as readonly [string, string], basis: "a stored relation marks them as contradicting" }] as const];
  })).values()];
  return {
    claims,
    disagreements,
    claims_status: evidence?.unavailable ? "unavailable" : claims.length > 0 ? "available" : "none",
    claims_truncated: evidence?.truncated === true,
  };
}

const STANCE: Readonly<Record<string, PacketClaim["stance"]>> = {
  positive: "supporting",
  negative: "challenging",
  neutral: "neutral",
};

function claimBounds(scope: ResearchScope | undefined, cutoff: string): string {
  const { predicate_prefixes: prefixes, effective_from: from } = claimSelection(scope, cutoff);
  const route = prefixes.length > 0
    ? `${new Intl.ListFormat("en").format(prefixes.map((prefix) => prefix.replace(/\.$/, "")))} claims${from ? ` from ${from.slice(0, 10)}` : ""} first, then the most recent others`
    : "the most recent claims";
  return `${route}, published by the ${cutoff.slice(0, 10)} cutoff; a claim repeated by several sources or copies counts once`;
}

// The packet as the model sees it: short ids only, no fact or source ids.
export function packetForModel(packet: EvidencePacket): Record<string, unknown> {
  return {
    route: packet.route,
    cutoff: packet.cutoff,
    figures: packet.figures.map(({ fact_id: _factId, source_ids: _sourceIds, ...figure }) => figure),
    ...(packet.coverage.length > 0 ? { coverage: packet.coverage } : {}),
    ...(packet.gaps.length > 0 ? { gaps: packet.gaps } : {}),
    ...(Object.keys(packet.query_bounds).length > 0 ? { query_bounds: packet.query_bounds } : {}),
    ...(packet.claims.length > 0
      ? { claims: packet.claims.map(({ claim_id: _claimId, source_id: _sourceId, ...claim }) => claim) }
      : {}),
    ...(packet.disagreements.length > 0 ? { disagreements: packet.disagreements } : {}),
    ...(packet.claims_status === "unavailable" ? { claims_status: "unavailable" } : {}),
    ...(packet.claims_truncated ? { claims_truncated: true } : {}),
  };
}

// The periods and window the readers were asked for (fact-blocks.ts), so the
// answer can say what the data covers and what it was never asked to cover.
function queryBounds(scope: ResearchScope): Record<string, string> {
  const periods: Partial<Record<ResearchScope["reads"], string>> = {
    latest_quarter: `latest quarter, with revenue for the last ${QUARTERS_SHOWN} quarters`,
    trend: `last ${QUARTERS_SHOWN} quarters`,
    derived_margin: `latest quarter, with revenue for the last ${QUARTERS_SHOWN} quarters`,
    segments: "latest quarter's segments",
    comparison: scope.fiscal_year === null ? "latest fiscal year per company" : `fiscal year ${scope.fiscal_year} per company`,
  };
  return {
    ...(periods[scope.reads] ? { periods: periods[scope.reads]! } : {}),
    ...(scope.price_window ? { price_window: `year to date, to the ${scope.price_window.cutoff.slice(0, 10)} cutoff` } : {}),
  };
}

function sourceIds(block: Block): string[] {
  const refs = Array.isArray(block.source_refs) ? block.source_refs : [];
  return unique(refs.flatMap((ref) => isString(ref) ? [ref] : isRecord(ref) && isString(ref.id) ? [ref.id] : []));
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
