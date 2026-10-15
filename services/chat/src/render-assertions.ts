// Controlled rendering of evidence-bound assertions (#208): the answer written
// from the assertions that passed the check, each in a fixed template, with
// every value and attributed claim a sealed ref segment rather than free text.
// An observation states only its figures (company, metric, value, period, from
// the packet); a management attribution quotes its claim, dated; an unknown
// cause says the figures do not show why; an inference is labelled. The model's
// own wording survives only in an inference, which the check has bound to the
// observations it rests on. A comparison states the high or low, ranking or
// trend its check derived, never the model's wording of it.

import { linkFigures, type Assertion } from "./assertions.ts";
import { checkComparison, periodText, type CheckedComparison } from "./comparisons.ts";
import type { EvidencePacket, PacketFigure } from "./evidence-packet.ts";
import { createSealer, type Segment } from "./prose-refs.ts";

type Block = Record<string, unknown>;

export type RenderedAssertion = {
  index: number;
  segments: ReadonlyArray<Segment>;
  // The fact bindings and sources its refs need to seal.
  fact_bindings: ReadonlyArray<Record<string, unknown>>;
  source_refs: ReadonlyArray<string>;
  // A value had no fact to seal (a price return read off its chart): plain
  // text, so the assertion is not rendered.
  unsealed: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function renderAssertion(
  assertion: Assertion & { index: number },
  packet: EvidencePacket,
  factBlocks: ReadonlyArray<Block>,
  // An inference's supported evidence: its observations' and comparisons' F ids.
  supported: ReadonlyArray<string> = [],
): RenderedAssertion {
  const figures = assertion.evidence.flatMap((id) => packet.figures.filter((figure) => figure.id === id));
  const claims = assertion.evidence.flatMap((id) => packet.claims.filter((claim) => claim.id === id));
  const owner = (figure: PacketFigure) => {
    const company = figure.company ?? (packet.companies.length === 1 ? packet.companies[0] : undefined);
    return company ? `${company}'s ` : "";
  };
  const seal = createSealer(factBlocks);
  const { value, quote } = seal;
  // An inference's text could not be linked: its numbers stay plain, unsealed.
  let unlinked = false;

  const segments: Segment[] = [];
  const text = (value: string) => segments.push({ type: "text", text: value });
  switch (assertion.kind) {
    case "observation": {
      // One clause per company and period, its period said once: "NVDA's
      // gross margin was 74.4%, operating margin 64.9% and ... in Q4 2026".
      const groups = new Map<string, PacketFigure[]>();
      for (const figure of figures) {
        const key = `${owner(figure)}|${figure.period ?? ""}|${figure.period_end ?? ""}`;
        groups.set(key, [...(groups.get(key) ?? []), figure]);
      }
      [...groups.values()].forEach((group, g) => {
        group.forEach((figure, i) => {
          const joiner = i === 0 ? "" : i === group.length - 1 ? " and " : ", ";
          text(i === 0 ? `${g === 0 ? "" : "; "}${capitalize(`${owner(figure)}${figureLabel(figure)}`)} was ` : `${joiner}${figureLabel(figure)} `);
          segments.push(value(figure));
        });
        text(periodPhrase(group[0]!));
      });
      text(".");
      break;
    }
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
    case "comparison": {
      const checked = checkComparison(assertion, assertion.evidence, packet);
      // Accepted assertions passed this check; a failure here renders nothing.
      if ("comparison" in checked) comparisonSegments(checked.comparison, { text, value, owner, push: (segment) => segments.push(segment) });
      break;
    }
    case "unknown_cause": {
      const changed = [...new Set(figures.map((figure) => `${owner(figure)}${metricLabel(figure.metric)}`))];
      text(`The figures do not show why ${changed.join(" and ")} changed.`);
      break;
    }
    case "analyst_inference": {
      // Its numbers are its supports' figures, each a fact ref; one that
      // binds to no single supported figure leaves it unsealed (not rendered).
      text("> **Analyst inference:** ");
      const links = linkFigures(assertion.text, [...assertion.evidence, ...supported], packet);
      if (!links) {
        unlinked = true;
        text(assertion.text);
        break;
      }
      let from = 0;
      for (const link of links) {
        text(assertion.text.slice(from, link.at));
        segments.push(value(packet.figures.find((figure) => figure.id === link.figureId)!));
        from = link.at + link.length;
      }
      text(assertion.text.slice(from));
      break;
    }
  }
  const { fact_bindings, source_refs, unsealed } = seal.sealed();
  return { index: assertion.index, segments, fact_bindings, source_refs, unsealed: unsealed || unlinked };
}

type Writer = {
  text: (value: string) => void;
  value: (figure: PacketFigure) => Segment;
  owner: (figure: PacketFigure) => string;
  push: (segment: Segment) => void;
};

// A comparison in its template: the derived result, with every value it
// names a fact ref. Across companies, every company's value and period is
// listed, so the basis (and any period mismatch) is on the page.
function comparisonSegments(comparison: CheckedComparison, out: Writer): void {
  const { figures, metric } = comparison;
  const first = figures[0]!;
  const last = figures.at(-1)!;
  const subject = (figure: PacketFigure) => capitalize(`${out.owner(figure)}${metricLabel(metric)}`);
  const at = (figure: PacketFigure) => {
    out.push(out.value(figure));
    if (figure.period) out.text(` in ${periodText(figure.period)}`);
  };
  // Across companies, each value's period; one period they all share is said once.
  const datedAs = (figure: PacketFigure) => (figure.period ? ` (${periodText(figure.period)}${figure.period_end ? `, ended ${monthYear(figure.period_end)}` : ""})` : "");
  const shared = new Set(figures.map(datedAs)).size === 1;
  const list = (label: (figure: PacketFigure) => string) => {
    figures.forEach((figure, i) => {
      out.text(`${i === 0 ? "" : ", "}${label(figure)} `);
      out.push(out.value(figure));
      if (comparison.axis === "cohort" && !shared) out.text(datedAs(figure));
    });
    if (comparison.axis === "cohort" && shared) out.text(datedAs(first));
  };
  const companyOf = (figure: PacketFigure) => figure.segment ?? figure.company ?? "";
  // A segment cohort is one company's segments.
  const segmented = first.segment !== undefined;
  if (comparison.op === "highest" || comparison.op === "lowest") {
    if (comparison.axis === "time") {
      out.text(`${subject(comparison.winner!)} was ${comparison.op} in ${periodText(comparison.winner!.period!)}, at `);
      out.push(out.value(comparison.winner!));
      out.text(`, of the periods from ${periodText(first.period!)} to ${periodText(last.period!)}.`);
    } else {
      out.text(segmented
        ? `Of ${out.owner(first)}segments, ${comparison.winner!.segment} ${metricLabel(metric)} was ${comparison.op}: `
        : `Of ${new Intl.ListFormat("en").format(figures.map(companyOf))}, ${subject(comparison.winner!)} was ${comparison.op}: `);
      list(companyOf);
      out.text(".");
    }
  } else if (comparison.op === "order") {
    out.text(comparison.axis === "time" ? `${subject(first)}, highest first: ` : `By ${metricLabel(metric)}, highest first: `);
    list((figure) => (comparison.axis === "time" ? periodText(figure.period!) : companyOf(figure)));
    out.text(".");
  } else {
    const { result, net, every_step, turn } = comparison.trend!;
    const where = net === 1 ? "above where it started" : net === -1 ? "below where it started" : "about where it started";
    out.text(`${subject(first)} `);
    if (result === "rose_throughout" || result === "fell_throughout") {
      out.text(`${result === "rose_throughout" ? "rose" : "fell"} in every period from ${periodText(first.period!)} (`);
      out.push(out.value(first));
      out.text(`) to ${periodText(last.period!)} (`);
      out.push(out.value(last));
      out.text(").");
    } else if (result === "rebounded" || result === "pulled_back") {
      const rebound = result === "rebounded";
      out.text(`${rebound ? "fell" : "rose"} from `);
      at(first);
      out.text(` to a ${rebound ? "low" : "high"} of `);
      at(turn!);
      out.text(`, then ${rebound ? "rebounded" : "pulled back"} to `);
      at(last);
      out.text(`, ${(rebound ? net === -1 : net === 1) ? "still " : ""}${where}.`);
    } else {
      out.text(result === "flat" ? "was little changed, from " : `${result} from `);
      at(first);
      out.text(" to ");
      at(last);
      out.text(result !== "flat" && !every_step ? ", though not in every period." : ".");
    }
  }
  if (comparison.not_shown.length > 0) {
    out.text(` No ${metricLabel(metric)} is shown for ${new Intl.ListFormat("en").format(comparison.not_shown)}.`);
  }
}

// Companies whose same-named periods end in different months: said once for
// the whole answer, whichever observations show them.
export function calendarsDiffer(figures: ReadonlyArray<PacketFigure>): boolean {
  return figures.some((a) => figures.some((b) =>
    a.company !== b.company && a.period !== undefined && a.period === b.period &&
    a.period_end !== undefined && b.period_end !== undefined && a.period_end.slice(0, 7) !== b.period_end.slice(0, 7)
  ));
}

// The text a rendered assertion reads as, for the narrative guard.
export function plainText(segments: ReadonlyArray<Segment>): string {
  return segments.map((segment) => (segment.type === "text" ? segment.text : segment.format)).join("");
}

// "Gross Margin" reads "gross margin" after a possessive; "EPS" and "YoY" stay.
function metricLabel(metric: string): string {
  return metric.replace(/\b([A-Z])(?=[a-z]+\b)/g, (letter) => letter.toLowerCase());
}

// A segment's figure is its revenue: "Data Center revenue".
function figureLabel(figure: PacketFigure): string {
  return figure.segment ? `${figure.segment} ${metricLabel(figure.metric)}` : metricLabel(figure.metric);
}

// A stored quarter ("Q42026") reads as "Q4 2026", and a window's dates by
// month and year, never the day; the end month is said, since fiscal
// calendars differ (#180).
function periodPhrase(figure: PacketFigure): string {
  const period = figure.period
    ? ` in ${periodText(figure.period).replace(/\d{4}-\d{2}-\d{2}/g, (date) => monthYear(date))}`
    : "";
  return `${period}${figure.period_end ? ` (ended ${monthYear(figure.period_end)})` : ""}`;
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
