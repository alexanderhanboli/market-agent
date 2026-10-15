// One answer turn as recorded: what the answer model was given, what it wrote
// raw, what the checks did, and the blocks shown. Written under CHAT_TRACE_DIR;
// replayed by scripts/answer-lab.ts.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LlmChatClient, LlmSettingsLoaderEnv } from "../../llm/src/index.ts";
import type { AssertionReport } from "./assertions.ts";
import {
  assertionRenderingEnabled,
  composeAnalystBlocksWithLlm,
  FACT_BLOCKS_FALLBACK_TEXT,
  NO_ANSWER_FALLBACK_TEXT,
  type AnswerUsage,
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
};

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

// Written only when CHAT_TRACE_DIR is set; a failed write never fails the turn,
// and a stalled one holds it at most waitMs (the write carries on behind it).
export async function writeTurnTrace(dir: string | undefined, trace: TurnTrace, waitMs = 2_000): Promise<void> {
  if (!dir) return;
  const ids = `thread=${trace.thread_id} run=${trace.run_id}${trace.turn_id ? ` turn=${trace.turn_id}` : ""}`;
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
  // Figures in the answer's prose as sealed fact refs.
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
    figure_refs: prose.flat().filter((segment) => segment.type === "ref" && segment.ref_kind === "fact").length,
    plain_numbers: prose.flatMap((segments) => text(segments).match(/\d+(?:[.,]\d+)*/g) ?? []).length,
    removed: trace.removed.length,
    fallback: prose.some((segments) => [FACT_BLOCKS_FALLBACK_TEXT, NO_ANSWER_FALLBACK_TEXT].includes(text(segments))),
    accepted: trace.assertions?.accepted.length ?? 0,
    rejected: trace.assertions?.rejected.length ?? 0,
    output_tokens: trace.exchange?.usage?.output_tokens ?? 0,
    latency_ms: trace.exchange?.latency_ms ?? 0,
  };
}
