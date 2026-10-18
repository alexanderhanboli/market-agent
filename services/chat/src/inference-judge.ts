// An entailment judge for analyst inferences (#302, #301 option 3). With
// assertions rendered, every figure, company and period on the page is a
// packet template's; the model's own words survive only in an inference's
// text. The word rules in assertions.ts catch a digit, a number word before a
// unit, and a company's label, but no English matcher can tell whether the
// words mean what their supports show ("margins are expanding" beside a
// checked "fell"). A second model reads each inference beside what it rests
// on, as the reader sees it, and says whether that backs it.
//
// An eval metric for now (scripts/answer-lab.ts --judge): nothing in the turn
// calls it, and its verdicts gate nothing.

import { createLlmRouterFromEnv, type LlmChatClient, type LlmChatMessage, type LlmSettingsLoaderEnv } from "../../llm/src/index.ts";
import type { Assertion } from "./assertions.ts";
import type { EvidencePacket } from "./evidence-packet.ts";
import { withDeadlines, type AnswerUsage, type ModelDeadlines } from "./llm-runtime.ts";
import { checkedResults, plainText, renderAssertion } from "./render-assertions.ts";

// One accepted inference and what it rests on, as the page shows them.
export type JudgeCase = {
  index: number;
  // The company it is about: its label's, or a one-company answer's.
  subject?: string;
  text: string;
  // Its label: what the comparisons it rests on checked.
  checked: ReadonlyArray<string>;
  // Each support's rendered text, its figures the packet's values.
  supports: ReadonlyArray<string>;
};

export type InferenceVerdict =
  | { index: number; verdict: "entailed" | "not_entailed"; reason?: string }
  // The judge gave no usable verdict: never read as entailed.
  | { index: number; verdict: "error"; reason: string };

export type JudgeOutcome = {
  verdicts: ReadonlyArray<InferenceVerdict>;
  // Null when no model was called.
  deployment: string | null;
  latency_ms: number;
  usage?: AnswerUsage;
};

// One attempt and a fallback, as for an answer: the judge reads a whole answer.
export const JUDGE_DEADLINES: ModelDeadlines = { attemptMs: 60_000, totalMs: 130_000 };

type Accepted = Assertion & { index: number };

export function judgeCases(accepted: ReadonlyArray<Accepted>, packet: EvidencePacket, factBlocks: ReadonlyArray<Record<string, unknown>>): JudgeCase[] {
  return accepted.filter((assertion) => assertion.kind === "analyst_inference").map((inference) => {
    const subject = inference.subject ?? (packet.companies.length === 1 ? packet.companies[0] : undefined);
    return {
      index: inference.index,
      ...(subject ? { subject } : {}),
      text: inference.text,
      checked: checkedResults(inference, packet, accepted),
      supports: (inference.supports ?? []).flatMap((n) => {
        const support = accepted.find((entry) => entry.index === n);
        return support ? [plainText(renderAssertion(support, packet, factBlocks, accepted).segments)] : [];
      }),
    };
  });
}

// All of an answer's inferences in one call. No temperature: current Claude
// models reject one (pi-adapter.ts).
export async function judgeInferences(input: {
  cases: ReadonlyArray<JudgeCase>;
  companies: ReadonlyArray<string>;
  env: LlmSettingsLoaderEnv;
  createClient?: () => Promise<LlmChatClient> | LlmChatClient;
  deadlines?: ModelDeadlines;
}): Promise<JudgeOutcome> {
  if (input.cases.length === 0) return { verdicts: [], deployment: null, latency_ms: 0 };
  const failed = (reason: string, rest: Omit<JudgeOutcome, "verdicts"> = { deployment: null, latency_ms: 0 }): JudgeOutcome => ({
    ...rest,
    verdicts: input.cases.map(({ index }) => ({ index, verdict: "error", reason })),
  });
  const router = await createLlmRouterFromEnv(input.env, { createClient: input.createClient, purpose: "judge" });
  if (!router) return failed("no judge model is configured");
  const startedAt = performance.now();
  const result = await router.complete(
    { messages: judgeMessages(input.cases, input.companies), reasoning: "low", maxTokens: 4096 },
    withDeadlines(input.deadlines ?? JUDGE_DEADLINES),
  ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (result instanceof Error) {
    return failed(`judge call failed: ${result.message}`, { deployment: null, latency_ms: Math.round(performance.now() - startedAt) });
  }
  const outcome = {
    deployment: `${result.deployment.channel}/${result.deployment.model}`,
    latency_ms: Math.round(performance.now() - startedAt),
    ...(result.usage ? { usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens } } : {}),
  };
  if (result.truncated) return failed("the judge's reply was cut off", outcome);
  return { ...outcome, verdicts: parseVerdicts(result.text, input.cases) };
}

export function judgeMessages(cases: ReadonlyArray<JudgeCase>, companies: ReadonlyArray<string>): LlmChatMessage[] {
  return [
    { role: "system", content: JUDGE_INSTRUCTIONS },
    {
      role: "user",
      content: JSON.stringify({
        companies,
        inferences: cases.map(({ index, subject, text, checked, supports }) => ({
          id: index,
          subject: subject ?? null,
          text,
          checked_results: checked,
          supports,
        })),
      }),
    },
  ];
}

// A verdict per case. A reply with no verdict list leaves every case an error;
// a case with no well-formed verdict of its own is one too.
export function parseVerdicts(text: string, cases: ReadonlyArray<JudgeCase>): InferenceVerdict[] {
  const items = lastVerdictList(text);
  if (items === undefined) return cases.map(({ index }) => ({ index, verdict: "error", reason: "the judge's reply is not a verdict list" }));
  return cases.map(({ index }): InferenceVerdict => {
    const mine = items.filter((item) => (item as { id?: unknown } | null)?.id === index);
    if (mine.length !== 1) return { index, verdict: "error", reason: mine.length === 0 ? "no verdict for this inference" : "more than one verdict for this inference" };
    const { verdict, reason } = mine[0] as { verdict?: unknown; reason?: unknown };
    if (verdict !== "entailed" && verdict !== "not_entailed") return { index, verdict: "error", reason: `unknown verdict ${JSON.stringify(verdict)}` };
    return { index, verdict, ...(typeof reason === "string" && reason.trim() !== "" ? { reason: reason.trim() } : {}) };
  });
}

// The reply's last verdict list: a model that corrects itself in prose
// ("Correction: ... Final answer:") writes its final list last.
function lastVerdictList(text: string): unknown[] | undefined {
  const end = text.lastIndexOf("}") + 1;
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      const verdicts = (JSON.parse(text.slice(start, end)) as { verdicts?: unknown } | null)?.verdicts;
      if (Array.isArray(verdicts)) return verdicts;
    } catch {
      // Not a whole object from here: try the brace before.
    }
    if (start === 0) break;
  }
  return undefined;
}

const JUDGE_INSTRUCTIONS = [
  "You check the analyst inferences in a financial research answer. The reader sees each inference beside",
  "what it rests on: its supports (the observations and comparisons it cites, each figure as the data gives",
  "it), the checked results of the comparisons among them, and its subject, the company it is about.",
  "companies lists every company the answer covers. Judge each inference only against its own subject,",
  "checked results and supports; no outside knowledge, and nothing from another inference.",
  "",
  "An inference is entailed when its supports state or clearly imply what it says. Qualitative words that",
  "summarise the supports' figures (large, concentrated, higher, slowing) are fine when the figures bear them",
  "out, and so is a count of the things the supports list (\"the two companies\", \"four segments\").",
  "It is not_entailed when any of these hold; the reason starts with its code:",
  "- unsupported: it claims something the supports neither state nor imply, such as a cause, a forecast, a",
  "  trend, or a metric, segment or period they do not show.",
  "- worded_amount: it states an amount or quantity in words, whether or not the supports bear it out:",
  "  money, a percentage, a growth rate, a multiple or fraction (\"doubled\", \"four times\", \"two-thirds\"),",
  "  or a span of time (\"an eight-month gap\"), e.g. \"hundreds of millions of dollars\", \"a quarter",
  "  billion dollars\", \"one and a half percent\", \"single-digit growth\".",
  "- other_company: it names, in any case or by any name, ticker or alias (\"nvda\", \"NVIDIA\", \"Advanced",
  "  Micro Devices\"), a company that is not its subject. With no subject, naming any company is this.",
  "- contradicts_ranking: who leads, trails, is highest or lowest, or the order it states disagrees with",
  "  the checked results or the supports' figures.",
  "- contradicts_trend: a direction it states (rising, falling, expanding, recovering) disagrees with a",
  "  checked trend or the supports' figures.",
  "",
  "Reply with JSON only, one verdict per inference id; if you correct yourself, the last JSON in the reply is read:",
  '{"verdicts":[{"id":<id>,"verdict":"entailed"|"not_entailed","reason":"<code>: <one short sentence>"}]}',
  "Give a reason for every not_entailed verdict; for entailed, leave it out.",
].join("\n");
