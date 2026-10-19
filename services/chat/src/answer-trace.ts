// One answer turn as recorded: what the answer model was given, what it wrote
// raw, what the checks did, what the judge did with its inferences, and the
// blocks the reader ended with. Written under CHAT_TRACE_DIR; replayed by
// scripts/answer-lab.ts.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { loadLlmSettingsFromEnv, type LlmChatClient, type LlmSettingsLoaderEnv } from "../../llm/src/index.ts";
import type { AssertionReport } from "./assertions.ts";
import { judgeCases, judgeInferences, judgeMessages, verdictsOf, type JudgeCase, type JudgeRecord } from "./inference-judge.ts";
import { composeAnalystBlocksWithLlm, turnPacket, type AnswerBlocks, type AnswerUsage, type ModelDeadlines } from "./llm-runtime.ts";

export type AnswerTraceInput = Omit<
  Parameters<typeof composeAnalystBlocksWithLlm>[0],
  "env" | "createClient" | "deadlines" | `on${string}`
>;

export type ModelExchange = {
  messages: ReadonlyArray<{ role: string; content: string }>;
  text: string;
  truncated: boolean;
  deployment: string;
  latency_ms: number;
  usage?: AnswerUsage;
};

export type TurnTrace = {
  version: 2;
  thread_id: string;
  run_id: string;
  turn_id?: string;
  question: string;
  recorded_at: string;
  input: AnswerTraceInput;
  // Null when no model was called.
  exchange: ModelExchange | null;
  // The checks' report; each inference the judge did not entail is a
  // rejection with check "judge", so the accepted inferences are those shown.
  assertions: AssertionReport | null;
  // What the judge did with the answer's inferences; null when it showed none
  // to judge. Absent from traces recorded before the judge gated them.
  judge?: JudgeRecord | null;
  blocks: ReadonlyArray<Record<string, unknown>>;
};

export type TracedAnswer = Pick<TurnTrace, "exchange" | "assertions" | "blocks"> & { judge: JudgeRecord | null };

// The answer as composed, its inferences not yet judged.
export type ComposedAnswer = Pick<TurnTrace, "exchange" | "assertions"> & { blocks: AnswerBlocks };

export async function composeTraced(
  input: AnswerTraceInput,
  options: {
    env: LlmSettingsLoaderEnv & Record<string, string | undefined>;
    createClient?: () => Promise<LlmChatClient> | LlmChatClient;
    onAnswered?: (deployment: string) => void;
  },
): Promise<ComposedAnswer> {
  let exchange: ModelExchange | null = null;
  let assertions: AssertionReport | null = null;
  const blocks = await composeAnalystBlocksWithLlm({
    ...input,
    ...options,
    onModelExchange: (sent) => {
      exchange = sent;
    },
    onAssertions: (report) => {
      assertions = report;
    },
  });
  return { exchange, assertions, blocks };
}

// The inferences a rendered answer would show, each beside what it rests on,
// as the judge reads them; the fallback sentence shows none.
export function inferenceCases(input: AnswerTraceInput, report: AssertionReport | null): { cases: JudgeCase[]; companies: ReadonlyArray<string> } {
  if (report?.rendered !== true) return { cases: [], companies: [] };
  const packet = turnPacket(input);
  return { cases: judgeCases(report.accepted, packet, input.factBlocks ?? []), companies: packet.companies };
}

// What the reader ends with: each inference the judge entailed, and none
// other. The rest leave the report's accepted list as "judge" rejections.
export function judgedAnswer(answer: ComposedAnswer, cases: ReadonlyArray<JudgeCase>, record: JudgeRecord): TracedAnswer {
  if (cases.length === 0) return { ...answer, judge: null, blocks: answer.blocks(new Set()) };
  const verdicts = verdictsOf(cases, record);
  const shown = new Set(verdicts.flatMap((entry) => (entry.verdict === "entailed" ? [entry.index] : [])));
  const hidden = verdicts.filter((entry) => entry.verdict !== "entailed");
  const report = answer.assertions!;
  return {
    exchange: answer.exchange,
    assertions: {
      ...report,
      accepted: report.accepted.filter((entry) => !hidden.some((verdict) => verdict.index === entry.index)),
      rejected: [
        ...report.rejected,
        ...hidden.map((verdict) => ({
          index: verdict.index,
          text: report.accepted.find((entry) => entry.index === verdict.index)!.text,
          check: "judge" as const,
          reason: `${verdict.verdict}${verdict.reason ? `: ${verdict.reason}` : ""}`,
        })),
      ].sort((a, b) => a.index - b.index),
    },
    judge: record,
    blocks: answer.blocks(shown),
  };
}

type JudgeOptions = {
  env: LlmSettingsLoaderEnv & Record<string, string | undefined>;
  createClient?: () => Promise<LlmChatClient> | LlmChatClient;
  judgeDeadlines?: ModelDeadlines;
};

// Only on JUDGE_LITELLM_MODEL: unset, judge calls fall back to the primary
// model, which was not approved for every turn, so no inference shows.
const NO_JUDGE: JudgeRecord = { outcome: "not_called", reason: "no judge model is configured" };

async function judgeConfigured(env: JudgeOptions["env"]): Promise<boolean> {
  return (await loadLlmSettingsFromEnv(env)).judgeModel !== null;
}

export async function judgeAnswer(cases: ReadonlyArray<JudgeCase>, companies: ReadonlyArray<string>, options: JudgeOptions): Promise<JudgeRecord> {
  if (!(await judgeConfigured(options.env))) return NO_JUDGE;
  return judgeInferences({
    cases,
    companies,
    env: options.env,
    ...(options.createClient ? { createClient: options.createClient } : {}),
    ...(options.judgeDeadlines ? { deadlines: options.judgeDeadlines } : {}),
  });
}

type TurnIds = Pick<TurnTrace, "thread_id" | "run_id" | "turn_id">;

export type AnsweredTurn = Pick<TracedAnswer, "exchange" | "assertions" | "blocks"> & {
  // Present while the judge reads the answer's inferences: `blocks` then hold a
  // line in each one's place, and this settles with what the reader ends with,
  // once the trace is written. It never rejects.
  judged?: Promise<Pick<TracedAnswer, "assertions" | "blocks">>;
};

// A chat turn's answer, gated by the judge, and its trace.
export async function answerTurn(
  input: AnswerTraceInput,
  turn: TurnIds & Pick<TurnTrace, "question">,
  options: JudgeOptions & { onAnswered?: (deployment: string) => void; traceDir?: string },
): Promise<AnsweredTurn> {
  const answer = await composeTraced(input, {
    env: options.env,
    ...(options.createClient ? { createClient: options.createClient } : {}),
    ...(options.onAnswered ? { onAnswered: options.onAnswered } : {}),
  });
  const recorded_at = new Date().toISOString();
  const { cases, companies } = inferenceCases(input, answer.assertions);
  const finish = async (record: JudgeRecord): Promise<TracedAnswer> => {
    const traced = judgedAnswer(answer, cases, record);
    if (cases.length > 0) {
      const shown = traced.assertions!.accepted.filter((entry) => entry.kind === "analyst_inference").length;
      const deployment = record.outcome === "replied" ? ` on ${record.exchange.deployment}` : "";
      console.info(`[chat] judge ${traceIds(turn)}${deployment}: ${shown} of ${cases.length} inferences shown${record.outcome === "replied" ? "" : ` (${record.reason})`}`);
    }
    await writeTurnTrace(options.traceDir, { version: 2, ...turn, recorded_at, input, ...traced });
    return traced;
  };
  if (cases.length === 0) return finish(NOTHING_TO_JUDGE);
  if (!(await judgeConfigured(options.env))) return finish(NO_JUDGE);
  return {
    exchange: answer.exchange,
    assertions: answer.assertions,
    blocks: answer.blocks("pending"),
    judged: judgeAnswer(cases, companies, options).then(finish).then(({ assertions, blocks }) => ({ assertions, blocks })),
  };
}

function traceIds(turn: TurnIds): string {
  return `thread=${turn.thread_id} run=${turn.run_id}${turn.turn_id ? ` turn=${turn.turn_id}` : ""}`;
}

// A recorded turn's input through today's post-processing, with the answer
// model's reply and the judge's record replaced by the ones recorded, so no
// model is called; or, given a judge, with its live verdicts in place of the
// recorded ones. The recorded answer exchange is kept: its output, latency and
// tokens are what was recorded. judge_input_changed: today's answer would send
// the judge something other than the recorded reply answered.
export async function replayRecorded(trace: TurnTrace, judge?: JudgeOptions): Promise<TurnTrace & { judge_input_changed: boolean }> {
  const { exchange } = trace;
  const answer = await composeTraced(trace.input, {
    env: exchange === null ? {} : RECORDED_CHANNEL,
    createClient: () => async () => ({
      text: exchange?.text ?? "",
      truncated: exchange?.truncated,
      ...(exchange?.usage
        ? {
          usage: {
            inputTokens: exchange.usage.input_tokens,
            outputTokens: exchange.usage.output_tokens,
            totalTokens: exchange.usage.input_tokens + exchange.usage.output_tokens,
            ...(exchange.usage.reasoning_tokens === undefined ? {} : { reasoningTokens: exchange.usage.reasoning_tokens }),
          },
        }
        : {}),
    }),
  });
  const { cases, companies } = inferenceCases(trace.input, answer.assertions);
  const record = cases.length === 0
    ? NOTHING_TO_JUDGE
    : judge ? await judgeAnswer(cases, companies, judge) : recordedJudge(trace);
  return {
    ...trace,
    version: 2,
    ...judgedAnswer(answer, cases, record),
    exchange,
    judge_input_changed: record.outcome === "replied" && !isDeepStrictEqual(record.exchange.messages, judgeMessages(cases, companies)),
  };
}

const NOTHING_TO_JUDGE: JudgeRecord = { outcome: "not_called", reason: "no inference to judge" };

// A trace from before the judge gated inferences recorded no judge reply (or
// only the shadow judge's verdicts): its inferences replay hidden.
function recordedJudge(trace: TurnTrace): JudgeRecord {
  const judge = trace.judge as JudgeRecord | null | undefined;
  return judge && typeof judge === "object" && "outcome" in judge ? judge : { outcome: "not_called", reason: "this trace recorded no judge reply" };
}

const RECORDED_CHANNEL = {
  LLM_CHANNELS: "recorded",
  LLM_RECORDED_PROTOCOL: "openai",
  LLM_RECORDED_MODELS: "reply",
  LITELLM_MODEL: "recorded/reply",
};

// Written only when CHAT_TRACE_DIR is set; a failed write never fails the turn,
// and a stalled one holds it at most waitMs (the write carries on behind it).
export async function writeTurnTrace(dir: string | undefined, trace: TurnTrace, waitMs = 2_000): Promise<void> {
  if (!dir) return;
  const ids = traceIds(trace);
  // The ids come from the request; none may leave the trace directory.
  if (![trace.thread_id, trace.run_id, trace.turn_id ?? "-"].every((id) => /^[\w-]+$/.test(id))) {
    console.warn(`[chat] trace not written: ${ids} is not a safe file name`);
    return;
  }
  // One run can carry several turns (coordinator.ts), each its own file.
  const path = join(dir, trace.thread_id, `${trace.run_id}${trace.turn_id ? `.${trace.turn_id}` : ""}.json`);
  const write = (async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      // Written aside, then renamed: a reader never sees half a trace.
      const partial = `${path}.partial`;
      await writeFile(partial, `${JSON.stringify(trace, null, 2)}\n`);
      await rename(partial, path);
      console.info(`[chat] trace ${ids} ${path}`);
    } catch (error) {
      console.warn(`[chat] trace not written: ${ids}`, error);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[chat] trace write still pending after ${waitMs} ms: ${ids}`);
      resolve();
    }, waitMs);
  });
  await Promise.race([write, late]);
  clearTimeout(timer);
}

export type AnswerMetrics = {
  // Figures in the answer as sealed refs: facts, and price returns as series.
  figure_refs: number;
  // Digit runs in its plain text, figures or not ("Q1", "2025", "$4.2").
  plain_numbers: number;
  // A model answered, and no assertion rendered.
  fallback: boolean;
  accepted: number;
  rejected: number;
  // The answer's inferences the judge entailed, and those it left out.
  inferences_shown: number;
  inferences_hidden: number;
  output_tokens: number;
  latency_ms: number;
};

type Segment = { type?: string; ref_kind?: string; text?: string };

export function answerMetrics(trace: Pick<TurnTrace, "blocks" | "assertions" | "exchange">): AnswerMetrics {
  const narrative = trace.blocks.filter((block) => block.kind === "rich_text")
    .map((block) => (Array.isArray(block.segments) ? block.segments as Segment[] : []));
  const text = (segments: ReadonlyArray<Segment>) =>
    segments.map((segment) => (segment.type === "text" ? segment.text ?? "" : "")).join("");
  return {
    figure_refs: narrative.flat().filter((segment) => segment.type === "ref" && (segment.ref_kind === "fact" || segment.ref_kind === "series")).length,
    plain_numbers: narrative.flatMap((segments) => text(segments).match(/\d+(?:[.,]\d+)*/g) ?? []).length,
    fallback: trace.exchange !== null && trace.assertions?.rendered !== true,
    accepted: trace.assertions?.accepted.length ?? 0,
    rejected: trace.assertions?.rejected.length ?? 0,
    inferences_shown: trace.assertions?.accepted.filter((entry) => entry.kind === "analyst_inference").length ?? 0,
    inferences_hidden: trace.assertions?.rejected.filter((entry) => entry.check === "judge").length ?? 0,
    output_tokens: trace.exchange?.usage?.output_tokens ?? 0,
    latency_ms: trace.exchange?.latency_ms ?? 0,
  };
}
