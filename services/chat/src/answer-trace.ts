// One answer turn as recorded: what the answer model was given, what it wrote
// raw, what the checks did, and the blocks shown. Written under CHAT_TRACE_DIR;
// replayed by scripts/answer-lab.ts.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadLlmSettingsFromEnv, type LlmChatClient, type LlmSettingsLoaderEnv } from "../../llm/src/index.ts";
import type { AssertionReport } from "./assertions.ts";
import { judgeCases, judgeInferences, type InferenceVerdict, type JudgeOutcome } from "./inference-judge.ts";
import {
  assertionRenderingEnabled,
  composeAnalystBlocksWithLlm,
  FACT_BLOCKS_FALLBACK_TEXT,
  NO_ANSWER_FALLBACK_TEXT,
  turnPacket,
  type AnswerUsage,
  type ModelDeadlines,
} from "./llm-runtime.ts";

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
  version: 1;
  thread_id: string;
  run_id: string;
  turn_id?: string;
  question: string;
  recorded_at: string;
  // CHAT_ASSERTION_RENDERING when recorded: it picks the post-processing path.
  assertion_rendering: boolean;
  input: AnswerTraceInput;
  // Null when no model was called.
  exchange: ModelExchange | null;
  assertions: AssertionReport | null;
  // The narrative guard's drops.
  removed: ReadonlyArray<string>;
  blocks: ReadonlyArray<Record<string, unknown>>;
  // The shadow judge's verdicts on the inferences shown, added after the turn (#302).
  judge?: JudgedAnswer;
};

// The judge's verdicts on an answer's accepted inferences, each with its text.
export type JudgedAnswer = Omit<JudgeOutcome, "verdicts"> & { verdicts: Array<InferenceVerdict & { text: string }> };

export type TracedAnswer = Pick<TurnTrace, "assertion_rendering" | "exchange" | "assertions" | "removed" | "blocks">;

export async function composeTraced(
  input: AnswerTraceInput,
  options: {
    env: LlmSettingsLoaderEnv & Record<string, string | undefined>;
    createClient?: () => Promise<LlmChatClient> | LlmChatClient;
    onAnswered?: (deployment: string) => void;
  },
): Promise<TracedAnswer> {
  let exchange: ModelExchange | null = null;
  let assertions: AssertionReport | null = null;
  let removed: ReadonlyArray<string> = [];
  const blocks = await composeAnalystBlocksWithLlm({
    ...input,
    ...options,
    onModelExchange: (sent) => {
      exchange = sent;
    },
    onAssertions: (report) => {
      assertions = report;
    },
    onNarrativeRemoved: (sentences) => {
      removed = sentences;
    },
  });
  return { assertion_rendering: assertionRenderingEnabled(options.env), exchange, assertions, removed, blocks };
}

type TurnIds = Pick<TurnTrace, "thread_id" | "run_id" | "turn_id">;

type JudgeOptions = {
  env: LlmSettingsLoaderEnv & Record<string, string | undefined>;
  createClient?: () => Promise<LlmChatClient> | LlmChatClient;
  judgeDeadlines?: ModelDeadlines;
};

// A chat turn's answer, its trace, and the shadow judge. The judge starts once
// the answer is composed and the turn never waits for it: judged settles after
// its verdicts are logged and added to the trace, and never rejects.
export async function answerTurn(
  input: AnswerTraceInput,
  turn: TurnIds & Pick<TurnTrace, "question">,
  options: JudgeOptions & { onAnswered?: (deployment: string) => void; traceDir?: string },
): Promise<TracedAnswer & { judged: Promise<JudgedAnswer | null> }> {
  const answer = await composeTraced(input, {
    env: options.env,
    ...(options.createClient ? { createClient: options.createClient } : {}),
    ...(options.onAnswered ? { onAnswered: options.onAnswered } : {}),
  });
  const trace: TurnTrace = { version: 1, ...turn, recorded_at: new Date().toISOString(), input, ...answer };
  const judged = shadowJudge(input, answer.assertions, turn, options).then(async (judge) => {
    if (judge) await writeTurnTrace(options.traceDir, { ...trace, judge });
    return judge;
  });
  await writeTurnTrace(options.traceDir, trace);
  return { ...answer, judged };
}

// Only with JUDGE_LITELLM_MODEL set: unset, judge calls fall back to the
// primary model, which was not approved for every turn. CHAT_JUDGE_SHADOW=0
// (or false, no, off) turns it off.
export async function judgeShadowEnabled(env: LlmSettingsLoaderEnv & Record<string, string | undefined>): Promise<boolean> {
  if (/^(?:0|false|no|off)$/i.test(env.CHAT_JUDGE_SHADOW?.trim() ?? "")) return false;
  return (await loadLlmSettingsFromEnv(env)).judgeModel !== null;
}

// The inferences a rendered answer shows; with rendering off, or not rendered,
// the reader sees prose, not inferences.
async function shadowJudge(input: AnswerTraceInput, report: AssertionReport | null, turn: TurnIds, options: JudgeOptions): Promise<JudgedAnswer | null> {
  try {
    if (report?.rendered !== true || !(await judgeShadowEnabled(options.env))) return null;
    const judged = await judgeAnswer(input, report, options);
    if (judged.verdicts.length === 0) return null;
    const count = (verdict: InferenceVerdict["verdict"]) => judged.verdicts.filter((entry) => entry.verdict === verdict).length;
    console.info(`[chat] judge ${traceIds(turn)} on ${judged.deployment ?? "no deployment"}: ${count("entailed")} entailed, ${count("not_entailed")} not entailed, ${count("error")} errors`);
    return judged;
  } catch (error) {
    console.warn(`[chat] judge not run: ${traceIds(turn)}`, error);
    return null;
  }
}

export async function judgeAnswer(input: AnswerTraceInput, report: AssertionReport | null, options: JudgeOptions): Promise<JudgedAnswer> {
  const packet = turnPacket(input);
  const cases = judgeCases(report?.accepted ?? [], packet, input.factBlocks ?? []);
  const outcome = await judgeInferences({
    cases,
    companies: packet.companies,
    env: options.env,
    ...(options.createClient ? { createClient: options.createClient } : {}),
    ...(options.judgeDeadlines ? { deadlines: options.judgeDeadlines } : {}),
  });
  return { ...outcome, verdicts: outcome.verdicts.map((verdict) => ({ ...verdict, text: cases.find((entry) => entry.index === verdict.index)!.text })) };
}

function traceIds(turn: TurnIds): string {
  return `thread=${turn.thread_id} run=${turn.run_id}${turn.turn_id ? ` turn=${turn.turn_id}` : ""}`;
}

// A recorded turn's input through today's post-processing, the model's reply
// replaced by the one recorded. The recorded exchange is kept: the model's
// output, latency and tokens are what was recorded.
export async function replayRecorded(trace: TurnTrace): Promise<TurnTrace> {
  const { exchange } = trace;
  const replayed = await composeTraced(trace.input, {
    env: exchange === null ? renderingEnv(trace) : { ...RECORDED_CHANNEL, ...renderingEnv(trace) },
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
  return { ...trace, ...replayed, exchange };
}

const RECORDED_CHANNEL = {
  LLM_CHANNELS: "recorded",
  LLM_RECORDED_PROTOCOL: "openai",
  LLM_RECORDED_MODELS: "reply",
  LITELLM_MODEL: "recorded/reply",
};

export function renderingEnv(trace: Pick<TurnTrace, "assertion_rendering">): Record<string, string> {
  return { CHAT_ASSERTION_RENDERING: trace.assertion_rendering ? "1" : "0" };
}

// Each path's last write: a trace rewritten with the judge's verdicts waits for
// the turn's own write, so the two never share the partial file.
const writing = new Map<string, Promise<void>>();

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
  const write = (writing.get(path) ?? Promise.resolve()).then(async () => {
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
  });
  writing.set(path, write);
  void write.then(() => {
    if (writing.get(path) === write) writing.delete(path);
  });
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
  // Figures in the answer's prose as sealed refs: facts, and price returns as series.
  figure_refs: number;
  // Digit runs in its plain text, figures or not ("Q1", "2025", "$4.2").
  plain_numbers: number;
  removed: number;
  fallback: boolean;
  accepted: number;
  rejected: number;
  output_tokens: number;
  latency_ms: number;
};

type Segment = { type?: string; ref_kind?: string; text?: string };

export function answerMetrics(trace: Pick<TurnTrace, "blocks" | "removed" | "assertions" | "exchange">): AnswerMetrics {
  const prose = trace.blocks.filter((block) => block.kind === "rich_text")
    .map((block) => (Array.isArray(block.segments) ? block.segments as Segment[] : []));
  const text = (segments: ReadonlyArray<Segment>) =>
    segments.map((segment) => (segment.type === "text" ? segment.text ?? "" : "")).join("");
  return {
    figure_refs: prose.flat().filter((segment) => segment.type === "ref" && (segment.ref_kind === "fact" || segment.ref_kind === "series")).length,
    plain_numbers: prose.flatMap((segments) => text(segments).match(/\d+(?:[.,]\d+)*/g) ?? []).length,
    removed: trace.removed.length,
    fallback: prose.some((segments) => [FACT_BLOCKS_FALLBACK_TEXT, NO_ANSWER_FALLBACK_TEXT].includes(text(segments))),
    accepted: trace.assertions?.accepted.length ?? 0,
    rejected: trace.assertions?.rejected.length ?? 0,
    output_tokens: trace.exchange?.usage?.output_tokens ?? 0,
    latency_ms: trace.exchange?.latency_ms ?? 0,
  };
}
