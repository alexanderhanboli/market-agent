// The answer model never types a figure. It writes a packet reference, [[F3]]
// for a figure or [[C2]] for a claim, and the server renders the reference as
// the packet's own value, sealed to its fact or claim where one can seal
// (2026-10-14 review, idea 1). This module owns that grammar: the table of
// references a turn allows, the one regex that reads them, the sealing of a
// value or a claim into a segment, and the conversion of kept prose into the
// rich_text segments the user sees.

import type { EvidencePacket, PacketClaim, PacketFigure } from "./evidence-packet.ts";
import { periodText } from "./comparisons.ts";

type Block = Record<string, unknown>;

export type Segment =
  | { type: "text"; text: string }
  | { type: "ref"; ref_kind: "fact" | "claim"; ref_id: string; format: string };

export type Reference =
  | { kind: "fact"; id: string; figure: PacketFigure }
  | { kind: "claim"; id: string; claim: PacketClaim };

export type ReferenceTable = {
  references: ReadonlyMap<string, Reference>;
  // The four-digit years the prose may write as a period: those of the
  // packet's periods, dates, bounds and cutoff, and of the blocks' titles.
  years: ReadonlySet<string>;
  // Words that mix letters and digits as the evidence writes them ("MI308",
  // "FY2026"): a product or label the prose may name, never a figure.
  words: ReadonlySet<string>;
};

// The only syntax read out of the model's prose: a packet id in double brackets.
export const REFERENCE = /\[\[([FC]\d+)\]\]/g;
const YEAR = /(?<!\d)\d{4}(?!\d)/g;
// A run of letters and digits with a digit in it, in any script: what the digit
// rule judges.
const DIGIT_WORD = /[\p{L}\p{Nd}]*\p{Nd}[\p{L}\p{Nd}]*/gu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function referenceTable(packet: EvidencePacket, factBlocks: ReadonlyArray<Block>): ReferenceTable {
  const references = new Map<string, Reference>([
    ...packet.figures.map((figure): [string, Reference] => [figure.id, { kind: "fact", id: figure.id, figure }]),
    ...packet.claims.map((claim): [string, Reference] => [claim.id, { kind: "claim", id: claim.id, claim }]),
  ]);
  const dated = [
    ...packet.figures.flatMap((figure) => [figure.period ? periodText(figure.period) : "", figure.period_end ?? ""]),
    ...packet.claims.flatMap((claim) => [claim.effective_time ?? "", claim.published_at ?? ""]),
    packet.cutoff,
    ...Object.values(packet.query_bounds),
    ...factBlocks.flatMap((block) => (typeof block.title === "string" ? [block.title] : [])),
  ];
  const written = [
    ...packet.claims.map((claim) => claim.text),
    ...packet.figures.flatMap((figure) => [figure.metric, figure.segment ?? ""]),
    ...factBlocks.flatMap((block) => (typeof block.title === "string" ? [block.title] : [])),
  ];
  return {
    references,
    years: new Set(dated.flatMap((text) => text.match(YEAR) ?? [])),
    // A name starts with a letter ("MI308"); one starting with a digit is a
    // figure ("800M" in a claim's "$800M"). A company label passes whole ("0700.HK").
    words: new Set([
      ...written.flatMap((text) => (text.match(DIGIT_WORD) ?? []).filter((word) => /^[A-Za-z]/.test(word))),
      ...packet.companies.flatMap((company) => company.match(DIGIT_WORD) ?? []),
    ]),
  };
}

// What a reference reads as: the figure's displayed value or the claim's text.
export function displayOf(reference: Reference): string {
  return reference.kind === "fact" ? reference.figure.value : reference.claim.text;
}

// Whether every word with a digit outside a reference is a period label (an
// allowed year, FY and one, or Q1-Q4, H1-H2) or a word the evidence writes.
export function onlyPeriodDigits(text: string, allowed: Pick<ReferenceTable, "years" | "words">): boolean {
  return (text.replace(REFERENCE, " ").match(DIGIT_WORD) ?? []).every((word) =>
    allowed.years.has(word) ||
    /^(?:Q[1-4]|H[12])$/.test(word) ||
    allowed.years.has(/^FY(\d{4})$/.exec(word)?.[1] ?? "") ||
    allowed.words.has(word)
  );
}

export type Sealer = {
  // A figure's value: a fact ref when its fact can seal here (a UUID with the
  // binding its fact block carries), otherwise the packet's value as plain text.
  value: (figure: PacketFigure) => Segment;
  // A claim's text: a claim ref when its id is a UUID, otherwise plain text.
  quote: (claim: PacketClaim) => Segment;
  // What the segments written so far need to seal, and whether any could not.
  sealed: () => { fact_bindings: ReadonlyArray<Record<string, unknown>>; source_refs: ReadonlyArray<string>; unsealed: boolean };
};

export function createSealer(factBlocks: ReadonlyArray<Block>): Sealer {
  const bindings = bindingsByFact(factBlocks);
  const factBindings: Array<Record<string, unknown>> = [];
  const sourceRefs = new Set<string>();
  let unsealed = false;
  return {
    value: (figure) => {
      const binding = figure.fact_id ? bindings.get(figure.fact_id) : undefined;
      if (!figure.fact_id || !UUID.test(figure.fact_id) || !binding) {
        unsealed = true;
        return { type: "text", text: figure.value };
      }
      factBindings.push(binding);
      figure.source_ids.forEach((id) => sourceRefs.add(id));
      return { type: "ref", ref_kind: "fact", ref_id: figure.fact_id, format: figure.value };
    },
    quote: (claim) => {
      if (!UUID.test(claim.claim_id)) return { type: "text", text: claim.text };
      sourceRefs.add(claim.source_id);
      return { type: "ref", ref_kind: "claim", ref_id: claim.claim_id, format: claim.text };
    },
    sealed: () => ({ fact_bindings: factBindings, source_refs: [...sourceRefs], unsealed }),
  };
}

export type ProseSegments = {
  segments: ReadonlyArray<Segment>;
  fact_bindings: ReadonlyArray<Record<string, unknown>>;
  source_refs: ReadonlyArray<string>;
};

// The kept prose as segments: each reference its packet value, sealed where it
// can be, and the text between as written. A unit the model repeats beside a
// figure's reference ("$[[F1]]", "[[F5]]%") is dropped when the value already
// carries it; nothing else about the text changes.
export function proseSegments(text: string, table: ReferenceTable, factBlocks: ReadonlyArray<Block>): ProseSegments {
  const seal = createSealer(factBlocks);
  const segments: Segment[] = [];
  let from = 0;
  // Adjacent text, a figure's unsealed value included, is one segment.
  const push = (segment: Segment) => {
    const last = segments.at(-1);
    if (segment.type === "text" && last?.type === "text") last.text += segment.text;
    else if (segment.type !== "text" || segment.text.length > 0) segments.push(segment);
  };
  const write = (value: string) => push({ type: "text", text: value });
  for (const match of text.matchAll(REFERENCE)) {
    const reference = table.references.get(match[1]!);
    if (!reference) continue;
    const at = match.index;
    let before = text.slice(from, at);
    from = at + match[0].length;
    if (reference.kind === "fact") {
      const value = reference.figure.value;
      const prefix = before.match(/\p{Sc}$/u)?.[0];
      if (prefix && value.replace(/^[-−]/, "").startsWith(prefix)) before = before.slice(0, -prefix.length);
      const suffix = text.slice(from).match(/^(?:%|[x×]|[BMKT](?![A-Za-z]))/)?.[0];
      if (suffix && value.endsWith(suffix)) from += suffix.length;
    }
    write(before);
    push(reference.kind === "fact" ? seal.value(reference.figure) : seal.quote(reference.claim));
  }
  write(text.slice(from));
  const { fact_bindings, source_refs } = seal.sealed();
  return { segments, fact_bindings, source_refs };
}

// A sentence with references as the user reads it: each its packet value, a
// unit typed beside it dropped as proseSegments drops it.
export function renderedText(text: string, table: ReferenceTable): string {
  return proseSegments(text, table, []).segments.map((segment) => (segment.type === "text" ? segment.text : segment.format)).join("");
}

// Rendered segments as prose with references, for the guard: each ref its
// packet id, so a template's own digits ("Q4 2026") read as periods.
export function referenceText(segments: ReadonlyArray<Segment>, table: ReferenceTable): string {
  const ids = new Map([...table.references.values()].map((reference) =>
    [reference.kind === "fact" ? `fact:${reference.figure.fact_id ?? ""}` : `claim:${reference.claim.claim_id}`, reference.id] as const
  ));
  return segments.map((segment) => {
    if (segment.type === "text") return segment.text;
    const id = ids.get(`${segment.ref_kind}:${segment.ref_id}`);
    return id === undefined ? segment.format : `[[${id}]]`;
  }).join("");
}

function bindingsByFact(blocks: ReadonlyArray<Block>): Map<string, Record<string, unknown>> {
  return new Map(blocks.flatMap((block) => {
    const params = (block.data_ref as { params?: { fact_bindings?: unknown } } | undefined)?.params;
    const list = Array.isArray(params?.fact_bindings) ? params.fact_bindings : [];
    return list.flatMap((binding) =>
      binding !== null && typeof binding === "object" && typeof (binding as { fact_id?: unknown }).fact_id === "string"
        ? [[(binding as { fact_id: string }).fact_id, binding as Record<string, unknown>] as const]
        : []
    );
  }));
}
