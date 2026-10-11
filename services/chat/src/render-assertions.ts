// Controlled rendering of evidence-bound assertions (#208): the answer written
// from the assertions that passed the check, each in a fixed template, with
// every value and attributed claim a sealed ref segment rather than free text.
// An observation states only its figures (company, metric, value, period, from
// the packet); a management attribution quotes its claim, dated; an unknown
// cause says the figures do not show why; an inference is labelled. The model's
// own wording survives only in an inference, which the check has bound to the
// observations it rests on.

import type { Assertion } from "./assertions.ts";
import type { EvidencePacket, PacketClaim, PacketFigure } from "./evidence-packet.ts";

type Segment =
  | { type: "text"; text: string }
  | { type: "ref"; ref_kind: "fact" | "claim"; ref_id: string; format: string };

type Block = Record<string, unknown>;

export type RenderedAssertion = {
  index: number;
  segments: ReadonlyArray<Segment>;
  // The fact bindings and sources its refs need to seal.
  fact_bindings: ReadonlyArray<Record<string, unknown>>;
  source_refs: ReadonlyArray<string>;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function renderAssertion(
  assertion: Assertion & { index: number },
  packet: EvidencePacket,
  factBlocks: ReadonlyArray<Block>,
): RenderedAssertion {
  const figures = assertion.evidence.flatMap((id) => packet.figures.filter((figure) => figure.id === id));
  const claims = assertion.evidence.flatMap((id) => packet.claims.filter((claim) => claim.id === id));
  const bindings = bindingsByFact(factBlocks);
  const owner = (figure: PacketFigure) => {
    const company = figure.company ?? (packet.companies.length === 1 ? packet.companies[0] : undefined);
    return company ? `${company}'s ` : "";
  };
  const fact_bindings: Array<Record<string, unknown>> = [];
  const source_refs = new Set<string>();
  // A value is a fact ref only when its fact can seal here: a UUID with the
  // binding the fact block carries; otherwise it is plain text.
  const value = (figure: PacketFigure): Segment => {
    const binding = figure.fact_id ? bindings.get(figure.fact_id) : undefined;
    if (!figure.fact_id || !UUID.test(figure.fact_id) || !binding) return { type: "text", text: figure.value };
    fact_bindings.push(binding);
    figure.source_ids.forEach((id) => source_refs.add(id));
    return { type: "ref", ref_kind: "fact", ref_id: figure.fact_id, format: figure.value };
  };
  const quote = (claim: PacketClaim): Segment => {
    if (!UUID.test(claim.claim_id)) return { type: "text", text: claim.text };
    source_refs.add(claim.source_id);
    return { type: "ref", ref_kind: "claim", ref_id: claim.claim_id, format: claim.text };
  };

  const segments: Segment[] = [];
  const text = (value: string) => segments.push({ type: "text", text: value });
  switch (assertion.kind) {
    case "observation":
      figures.forEach((figure, i) => {
        text(`${i === 0 ? "" : "; "}${capitalize(`${owner(figure)}${metricLabel(figure.metric)}`)} was `);
        segments.push(value(figure));
        // A stored quarter ("Q42026") reads as "Q4 2026".
        if (figure.period) text(` in ${figure.period.replace(/^([QH][1-4])(\d{4})$/, "$1 $2")}`);
      });
      text(".");
      break;
    case "management_attribution":
      claims.forEach((claim, i) => {
        // Dated by its publication; an effective date that differs is its own.
        const published = claim.published_at ? monthYear(claim.published_at) : undefined;
        const effective = claim.effective_time ? monthYear(claim.effective_time) : undefined;
        const dated = published ? `a source dated ${published}${effective && effective !== published ? `, effective ${effective}` : ""}` : `a source${effective ? `, effective ${effective}` : ""}`;
        text(`${i === 0 ? "" : " "}According to ${dated}${claim.company ? ` on ${claim.company}` : ""}: `);
        segments.push(quote(claim));
      });
      break;
    case "unknown_cause": {
      const changed = [...new Set(figures.map((figure) => `${owner(figure)}${metricLabel(figure.metric)}`))];
      text(`The figures do not show why ${changed.join(" and ")} changed.`);
      break;
    }
    case "analyst_inference":
      text(`> **Analyst inference:** ${assertion.text}`);
      break;
  }
  return { index: assertion.index, segments, fact_bindings, source_refs: [...source_refs] };
}

// The text a rendered assertion reads as, for the narrative guard.
export function plainText(segments: ReadonlyArray<Segment>): string {
  return segments.map((segment) => (segment.type === "text" ? segment.text : segment.format)).join("");
}

// "Gross Margin" reads "gross margin" after a possessive; "EPS" stays.
function metricLabel(metric: string): string {
  return metric.replace(/\b([A-Z])(?=[a-z])/g, (letter) => letter.toLowerCase());
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
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
