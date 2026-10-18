// Held-out research traps (#221): fixed cases on the frozen golden dataset, each
// declaring what the turn must establish (companies, period or window, blocks or
// a named gap, the ambiguity rule) and a known-good recorded answer whose
// assertion list passes. Each mutation keeps the known-good answer but changes
// one thing, and must fail one named check (assertions.ts rejectionCheck) or
// never reach the page. No model, provider or credential is involved: replies
// are recorded.
//
// Expected values are written from the golden dataset (test/golden/dataset.ts)
// by hand, not derived from the code under test. The suite is versioned: the
// digest of these cases is pinned in holdout.integration.test.ts, so a change
// to a case is a deliberate new version, never a quiet edit.
//
// Packet ids follow the order figures are shown (evidence-packet.ts): a single
// company's latest-quarter row F1-F9 (revenue, gross profit, operating and net
// income, gross/operating/net margin, QoQ and YoY growth), its eight revenue
// bars F10-F17, then any margin rows by quarter (gross F18-F25, operating
// F26-F33, net F34-F41); a comparison's companies four figures each (revenue,
// gross margin, net margin, YoY growth) in the order compared.

import type { RejectionCheck } from "../../src/assertions.ts";

export const HOLDOUT_VERSION = 5;

type Assertion = Record<string, unknown>;

export type HoldoutCase = {
  id: string;
  // The trap the case sets.
  trap: string;
  // The questions in order; the last is the one checked.
  turns: ReadonlyArray<string>;
  expect: {
    // The companies the checked turn covers, primary first (research scope).
    companies: ReadonlyArray<string>;
    route?: string;
    fiscal_year?: number | null;
    // A YTD window the scope keeps, as the chart draws it.
    ytd_range?: string;
    // Blocks that must be shown, by kind and title.
    blocks?: ReadonlyArray<{ kind: string; title?: string }>;
    // Kinds that must not be shown (a gap shows none of them).
    absent_kinds?: ReadonlyArray<string>;
    // A named gap the answer must state.
    gap?: string;
    // A value the answer must show, in a block's items.
    shows?: { block_title: string; label: string; format: string };
    // The turn asks instead of answering, binding no company.
    clarification?: boolean;
  };
  // The recorded answer for the checked turn: prose and, optionally, its
  // assertion list, which must pass in full.
  prose: string;
  good?: ReadonlyArray<Assertion>;
  mutations?: ReadonlyArray<
    | { name: string; list: ReadonlyArray<Assertion>; fails: { index: number; check: RejectionCheck } }
    // A prose mutation: a figure the data does not hold, which must never be shown.
    | { name: string; prose: string; never_shown: string }
    | { name: string; list: ReadonlyArray<Assertion>; never_shown: string }
  >;
};

const obs = (text: string, evidence: string[]): Assertion => ({ kind: "observation", text, evidence });
const cmp = (op: string, result: unknown, evidence: string[], text = "x"): Assertion => ({ kind: "comparison", op, result, text, evidence });
const inference = (text: string, supports: number[]): Assertion => ({ kind: "analyst_inference", text, supports });

const AMD_OPERATING_MARGINS = ["F26", "F27", "F28", "F29", "F30", "F31", "F32", "F33"];
const MI308 = "AMD said [[C1]]";

export const HOLDOUT_CASES: ReadonlyArray<HoldoutCase> = [
  {
    id: "three-company-order",
    trap: "ordering three companies; a wrong winner, a dropped peer or a figure credited to the wrong company",
    turns: ["Compare NVDA, AMD and AAPL on revenue and margins."],
    expect: { companies: ["NVDA", "AMD", "AAPL"], route: "comparison", blocks: [{ kind: "metrics_comparison" }] },
    prose: "AAPL has the largest revenue; AMD has the lowest net margin.",
    good: [
      cmp("highest", "F9", ["F1", "F5", "F9"]),
      cmp("lowest", "F7", ["F3", "F7", "F11"]),
      obs("NVDA's gross margin was [[F2]] in FY2026.", ["F2"]),
    ],
    mutations: [
      { name: "wrong winner", list: [cmp("highest", "F1", ["F1", "F5", "F9"])], fails: { index: 0, check: "comparative" } },
      { name: "dropped peer", list: [cmp("lowest", "F7", ["F3", "F7"])], fails: { index: 0, check: "comparative" } },
      {
        name: "wrong company",
        list: [cmp("highest", "F9", ["F1", "F5", "F9"]), cmp("lowest", "F7", ["F3", "F7", "F11"]), obs("AMD's gross margin was [[F2]] in FY2026.", ["F2"])],
        never_shown: "AMD's gross margin was",
      },
    ],
  },
  {
    id: "fiscal-period",
    trap: "the fiscal year asked for, whose calendars end eight months apart; a substituted year",
    turns: ["Compare NVDA's and AAPL's fiscal 2025 revenue."],
    expect: { companies: ["NVDA", "AAPL"], route: "comparison", fiscal_year: 2025, blocks: [{ kind: "metrics_comparison", title: "Side by side: NVDA FY2025 (ended Jan 2025), AAPL FY2025 (ended Sep 2025); fiscal years end 8 months apart" }] },
    prose: "NVDA's fiscal 2025 ended in January 2025, AAPL's in September 2025.",
    good: [obs("NVDA's revenue was [[F1]] in FY2025.", ["F1"]), obs("AAPL's revenue was [[F5]] in FY2025.", ["F5"])],
    mutations: [
      { name: "wrong fiscal year", list: [obs("NVDA's revenue was [[F1]] in FY2026.", ["F1"]), obs("AAPL's revenue was [[F5]] in FY2025.", ["F5"])], never_shown: "in FY2026" },
    ],
  },
  {
    id: "unknown-cause",
    trap: "a margin drop with no cause in evidence; a stated cause, or a cause given as a management attribution without a claim",
    turns: ["What changed in NVDA's gross margin in Q1 fiscal 2026?"],
    expect: { companies: ["NVDA"], route: "trend", blocks: [{ kind: "metric_row", title: "Gross margin by quarter" }] },
    prose: "NVDA's gross margin fell to 60.5% in Q1 2026; the data does not show why.",
    good: [
      obs("NVDA's gross margin was [[F21]] in Q4 2025 and [[F22]] in Q1 2026.", ["F21", "F22"]),
      { kind: "unknown_cause", text: "The data does not show why NVDA's gross margin fell.", evidence: ["F22"] },
    ],
    mutations: [
      { name: "stated cause", list: [obs("NVDA's gross margin fell to [[F22]] in Q1 2026, driven by inventory charges.", ["F22"])], never_shown: "inventory charges" },
      { name: "attribution without a claim", list: [{ kind: "management_attribution", text: "Management blamed inventory charges.", evidence: ["F22"] }], fails: { index: 0, check: "kind" } },
    ],
  },
  {
    id: "missing-cash-flow",
    trap: "free cash flow is not in the data: a named gap, never a number in its place",
    turns: ["What is AMD's free cash flow?"],
    expect: { companies: ["AMD"], gap: "Free cash flow is not available for AMD in this data", absent_kinds: ["metric_row", "revenue_bars"] },
    prose: "Free cash flow is not available for AMD in this data.",
    mutations: [
      { name: "a number in the gap's place", prose: "AMD's free cash flow was $3.1B in fiscal 2025.", never_shown: "$3.1B" },
    ],
  },
  {
    id: "restatement",
    trap: "a restated quarter shows its restated value; the superseded one is not a cited value",
    turns: ["Analyze AAPL's latest quarter."],
    expect: { companies: ["AAPL"], route: "latest_quarter", shows: { block_title: "Latest quarter (Q3 2026)", label: "Revenue", format: "$97.4B" } },
    prose: "AAPL's revenue was $97.4B in its latest quarter.",
    good: [obs("AAPL's revenue was [[F1]] in Q3 2026.", ["F1"])],
    mutations: [
      { name: "superseded value", list: [obs("AAPL's revenue was $97.1B in Q3 2026.", ["F1"])], never_shown: "$97.1B" },
    ],
  },
  {
    id: "segment-definition",
    trap: "a redefined segment shows its current definition's revenue; the obsolete definition's is not a cited value",
    turns: ["Break down NVDA's revenue by segment."],
    expect: { companies: ["NVDA"], route: "segments", shows: { block_title: "Revenue by segment (Q4 2026)", label: "Data Center", format: "$55.2B" } },
    prose: "Data Center is most of NVDA's revenue.",
    good: [obs("NVDA's Data Center revenue was [[F1]] in Q4 2026.", ["F1"])],
    mutations: [
      { name: "obsolete segment definition", list: [obs("NVDA's Data Center revenue was $50.0B in Q4 2026.", ["F1"])], never_shown: "$50.0B" },
    ],
  },
  {
    id: "ambiguous-follow-up",
    trap: "a follow-up naming a new company after a comparison could add it or switch to it: ask, never guess",
    turns: ["Compare NVDA with AMD.", "What about AAPL?"],
    expect: { companies: [], clarification: true, absent_kinds: ["metric_row", "metrics_comparison", "revenue_bars"] },
    prose: "",
  },
  {
    id: "interior-extremum-and-trend",
    trap: "a low inside the window, a rebound and net rise; an endpoint passed off as the low, a dropped quarter, a false every-quarter rise, a reversed direction",
    turns: ["How have AMD's operating margins trended over the last eight quarters?"],
    expect: { companies: ["AMD"], route: "trend", blocks: [{ kind: "metric_row", title: "Operating margin by quarter" }] },
    prose: "AMD's operating margin dipped into a loss in Q2 2025 and recovered.",
    good: [
      cmp("lowest", "F29", AMD_OPERATING_MARGINS),
      cmp("trend", "rebounded", AMD_OPERATING_MARGINS),
      cmp("trend", "rose", AMD_OPERATING_MARGINS),
    ],
    mutations: [
      { name: "endpoint as the low", list: [cmp("lowest", "F26", AMD_OPERATING_MARGINS)], fails: { index: 0, check: "comparative" } },
      { name: "dropped quarter", list: [cmp("lowest", "F26", AMD_OPERATING_MARGINS.filter((id) => id !== "F29"))], fails: { index: 0, check: "comparative" } },
      { name: "false every-quarter rise", list: [cmp("trend", "rose_throughout", AMD_OPERATING_MARGINS)], fails: { index: 0, check: "comparative" } },
      { name: "reversed direction", list: [cmp("trend", "fell", AMD_OPERATING_MARGINS)], fails: { index: 0, check: "comparative" } },
    ],
  },
  {
    id: "comparison-follow-up-scope",
    trap: "a follow-up keeps both companies and the sealed YTD window; a conclusion on a narrowed cohort or the wrong winner; an inference crediting one company with another's figure",
    turns: ["Analyze NVDA", "Compare it with AMD YTD", "Explain the differences and show the evidence"],
    expect: {
      companies: ["NVDA", "AMD"],
      route: "evidence_followup",
      ytd_range: "YTD 2026: 2025-12-31 close to 2026-08-31 close",
      blocks: [{ kind: "metrics_comparison" }, { kind: "perf_comparison" }],
    },
    prose: "NVDA's gross margin is higher than AMD's.",
    good: [
      cmp("highest", "F2", ["F2", "F6"]),
      obs("NVDA's revenue was [[F1]] in FY2026; AMD's was [[F5]] in FY2025.", ["F1", "F5"]),
      inference("The margin lead comes with the larger revenue base.", [0, 1]),
    ],
    mutations: [
      { name: "narrowed cohort", list: [cmp("highest", "F2", ["F2"])], fails: { index: 0, check: "kind" } },
      { name: "wrong winner", list: [cmp("highest", "F6", ["F2", "F6"])], fails: { index: 0, check: "comparative" } },
      // Beside a checked NVDA-highest, words naming a leader could contradict it (#288).
      {
        name: "an inference naming the leader",
        list: [cmp("highest", "F2", ["F2", "F6"]), inference("AMD's margin lead is the wider moat.", [0])],
        fails: { index: 1, check: "binding" },
      },
      // F5 is AMD's revenue, cited by the observation the inference rests on (#301).
      {
        name: "a reference swapped to another company's figure",
        list: [
          cmp("highest", "F2", ["F2", "F6"]),
          obs("NVDA's revenue was [[F1]] in FY2026; AMD's was [[F5]] in FY2025.", ["F1", "F5"]),
          inference("The margin lead comes with [[F5]] of revenue.", [0, 1]),
        ],
        fails: { index: 2, check: "binding" },
      },
    ],
  },
  {
    id: "filed-cause",
    trap: "a cause in evidence is a cited management attribution; a missing or duplicate claim reference, or the cause stated as an observation",
    turns: ["Why did AMD's operating margin turn negative in Q2 2025?"],
    expect: { companies: ["AMD"] },
    prose: "AMD's results were impacted by charges it attributed to the MI308 export control.",
    good: [{ kind: "management_attribution", text: MI308, evidence: ["C1"] }],
    mutations: [
      { name: "missing claim reference", list: [{ kind: "management_attribution", text: MI308, evidence: [] }], fails: { index: 0, check: "kind" } },
      { name: "duplicate claim reference", list: [{ kind: "management_attribution", text: MI308, evidence: ["C1", "C1"] }], fails: { index: 0, check: "reference" } },
      { name: "cause as an observation", list: [obs("AMD's revenue was [[F1]] in Q2 2026, driven by export controls.", ["F1"])], never_shown: "driven by export controls" },
    ],
  },
];

// Comparative traps on explicit values (#221): ties, negatives, rounded
// displays and missing intervals, with expected outcomes independent of the
// checker. Run against a declared packet, not a turn.
export type SyntheticFigure = { id: string; company?: string; metric: string; period: string; period_end?: string; value: string };
export const SYNTHETIC_FIGURES: ReadonlyArray<SyntheticFigure> = [
  { id: "T1", company: "NVDA", metric: "Net margin", period: "FY2026", value: "13.2%" },
  { id: "T2", company: "AMD", metric: "Net margin", period: "FY2025", value: "13.2%" },
  { id: "T3", company: "AAPL", metric: "Net margin", period: "FY2025", value: "13.25%" },
  { id: "N1", company: "NVDA", metric: "EPS growth", period: "FY2026", value: "-5.0%" },
  { id: "N2", company: "AMD", metric: "EPS growth", period: "FY2025", value: "-12.0%" },
  { id: "N3", company: "AAPL", metric: "EPS growth", period: "FY2025", value: "-8.0%" },
  { id: "R1", company: "AMD", metric: "Revenue", period: "Q1 2025", period_end: "2025-03-29", value: "$7.4B" },
  { id: "R3", company: "AMD", metric: "Revenue", period: "Q3 2025", period_end: "2025-09-27", value: "$9.2B" },
  { id: "R4", company: "AMD", metric: "Revenue", period: "Q4 2025", period_end: "2025-12-27", value: "$10.3B" },
];
export const SYNTHETIC_CASES: ReadonlyArray<{ name: string; assertion: Assertion; outcome: "accepted" | RejectionCheck }> = [
  { name: "a tie is no unique winner", assertion: cmp("highest", "T1", ["T1", "T2", "T3"]), outcome: "comparative" },
  { name: "values within rounding are a tie", assertion: cmp("highest", "T3", ["T1", "T2", "T3"]), outcome: "comparative" },
  { name: "the least negative is highest", assertion: cmp("highest", "N1", ["N1", "N2", "N3"]), outcome: "accepted" },
  { name: "the most negative is lowest", assertion: cmp("lowest", "N2", ["N1", "N2", "N3"]), outcome: "accepted" },
  { name: "a missing quarter allows a net rise", assertion: cmp("trend", "rose", ["R1", "R3", "R4"]), outcome: "accepted" },
  { name: "a missing quarter allows no every-quarter rise", assertion: cmp("trend", "rose_throughout", ["R1", "R3", "R4"]), outcome: "comparative" },
  { name: "an incomplete cohort allows no full-cohort superlative", assertion: cmp("lowest", "N2", ["N1", "N2"]), outcome: "comparative" },
];
