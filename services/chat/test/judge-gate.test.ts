import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { LlmChatRequest, LlmChatResult } from "../../llm/src/index.ts";
import { answerTurn, replayRecorded, type TurnTrace } from "../src/answer-trace.ts";

const trace = async (name: string): Promise<TurnTrace> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`./answer-lab/traces/${name}`, import.meta.url)), "utf8")) as TurnTrace;

const SEGMENTS = await trace("segment-drill-down.json");
const NO_INFERENCE = await trace("missing-cash-flow.json");

const ENV = {
  LLM_CHANNELS: "anthropic",
  LLM_ANTHROPIC_PROTOCOL: "anthropic",
  LLM_ANTHROPIC_API_KEY: "sk-test",
  LLM_ANTHROPIC_MODELS: "claude-sonnet-5-5,claude-haiku-5-5",
  LITELLM_MODEL: "anthropic/claude-sonnet-5-5",
};
const JUDGED_ENV = { ...ENV, JUDGE_LITELLM_MODEL: "anthropic/claude-haiku-5-5" };

const VERDICTS = '{"verdicts":[{"id":6,"verdict":"entailed"},{"id":7,"verdict":"not_entailed","reason":"unsupported: no support measures diversification."}]}';

const FIGURES = "By revenue, highest first: Data Center $55.2B, Gaming $4.3B, OEM & Other $1.1B, Professional Visualization $900.0M, Automotive $650.0M (Q4 2026, ended Jan 2026).";
const PENDING = "> _Checking an analyst inference against the figures it rests on…_";
const CONCENTRATED = "> **Analyst inference** (revenue highest first: Data Center, Gaming, OEM & Other, Professional Visualization, Automotive): NVIDIA's revenue is heavily concentrated in Data Center, creating significant single-segment exposure for the consolidated top line.";
const CUSHION = "> **Analyst inference** (revenue highest first: Data Center, Gaming, OEM & Other, Professional Visualization, Automotive): The other four segments provide limited diversification cushion relative to Data Center's dominance.";

// The answer model replies as recorded; the judge as given. Each call's model is kept.
function models(recorded: TurnTrace, judge: (request: LlmChatRequest) => Promise<LlmChatResult>) {
  const calls: string[] = [];
  const createClient = () => async (deployment: { channel: string; model: string }, request: LlmChatRequest): Promise<LlmChatResult> => {
    calls.push(`${deployment.channel}/${deployment.model}`);
    return request.messages[0]!.content.startsWith("You check the analyst inferences") ? judge(request) : { text: recorded.exchange!.text };
  };
  return { calls, createClient };
}

const turn = (recorded: TurnTrace) => ({ thread_id: recorded.thread_id, run_id: recorded.run_id, question: recorded.question });
const text = (blocks: ReadonlyArray<Record<string, unknown>>) =>
  (blocks[0]!.segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
const judgeRejections = (report: TurnTrace["assertions"]) =>
  (report?.rejected ?? []).filter((entry) => entry.check === "judge").map(({ index, reason }) => [index, reason]);

test("an inference shows only once the judge entails it: until then a line holds its place, and one not entailed never shows", async () => {
  const { calls, createClient } = models(SEGMENTS, async () => ({ text: VERDICTS }));
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient });

  assert.equal(text(answer.blocks), [FIGURES, PENDING, PENDING].join("\n\n"));
  const judged = await answer.judged!;
  assert.equal(text(judged.blocks), [FIGURES, CONCENTRATED].join("\n\n"));
  assert.deepEqual(judgeRejections(judged.assertions), [[7, "not_entailed: unsupported: no support measures diversification."]]);
  assert.deepEqual(judged.assertions?.accepted.filter((entry) => entry.kind === "analyst_inference").map((entry) => entry.index), [6]);
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"]);
});

test("an inference with no entailed verdict stays hidden: not entailed, a reply with none for it, a reply that is no verdict list, a failed call, a call past its deadline", async (t) => {
  const cases: Array<[string, (request: LlmChatRequest) => Promise<LlmChatResult>, Array<[number, string]>]> = [
    ["not entailed", async () => ({ text: VERDICTS.replace('"verdict":"entailed"', '"verdict":"not_entailed","reason":"unsupported: no support shows exposure."') }), [
      [6, "not_entailed: unsupported: no support shows exposure."],
      [7, "not_entailed: unsupported: no support measures diversification."],
    ]],
    ["no verdict for it", async () => ({ text: '{"verdicts":[{"id":6,"verdict":"not_entailed","reason":"unsupported: x."}]}' }), [
      [6, "not_entailed: unsupported: x."],
      [7, "error: no verdict for this inference"],
    ]],
    ["no verdict list", async () => ({ text: "Both look fine to me." }), [
      [6, "error: the judge's reply is not a verdict list"],
      [7, "error: the judge's reply is not a verdict list"],
    ]],
    ["a failed call", async () => {
      throw new Error("judge provider down");
    }, [
      [6, "error: judge call failed: all LLM deployments failed"],
      [7, "error: judge call failed: all LLM deployments failed"],
    ]],
    ["past its deadline", () => hang(t), [
      [6, "error: judge call failed: all LLM deployments failed"],
      [7, "error: judge call failed: all LLM deployments failed"],
    ]],
  ];
  for (const [label, judge, hidden] of cases) {
    const { createClient } = models(SEGMENTS, judge);
    const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient, judgeDeadlines: { attemptMs: 50, totalMs: 120 } });
    const judged = await answer.judged!;
    assert.equal(text(judged.blocks), FIGURES, label);
    assert.deepEqual(judgeRejections(judged.assertions), hidden, label);
  }
});

test("with no judge model configured no judge is asked, and no inference shows or waits", async () => {
  const { calls, createClient } = models(SEGMENTS, async () => assert.fail("no judge call without JUDGE_LITELLM_MODEL"));
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: ENV, createClient });
  assert.equal(answer.judged, undefined);
  assert.equal(text(answer.blocks), FIGURES);
  assert.deepEqual(judgeRejections(answer.assertions), [[6, "error: no judge model is configured"], [7, "error: no judge model is configured"]]);
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5"]);
});

test("an inference whose supports all failed their checks is neither judged nor shown", async () => {
  // The ranking is wrong, so the comparison both inferences rest on is rejected.
  const unsupported = { ...SEGMENTS, exchange: { ...SEGMENTS.exchange!, text: SEGMENTS.exchange!.text.replace('"op":"order","result":["F1","F2"', '"op":"order","result":["F2","F1"') } };
  const { calls, createClient } = models(unsupported, async () => assert.fail("nothing left to judge"));
  const answer = await answerTurn(unsupported.input, turn(unsupported), { env: JUDGED_ENV, createClient });
  assert.equal(answer.judged, undefined);
  assert.equal(text(answer.blocks).includes("Analyst inference"), false);
  assert.deepEqual(answer.assertions?.rejected.filter((entry) => entry.index === 6 || entry.index === 7).map(({ index, check }) => [index, check]), [[6, "support"], [7, "support"]]);
  assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5"]);
});

test("a turn that shows no inference makes no judge call: none rendered, or the fallback shown", async () => {
  const cases: TurnTrace[] = [
    NO_INFERENCE,
    // Its inferences are listed, but the list does not parse: the reader sees the fallback sentence.
    { ...SEGMENTS, exchange: { ...SEGMENTS.exchange!, text: SEGMENTS.exchange!.text.replace("```assertions\n[", "```assertions\n{") } },
  ];
  for (const recorded of cases) {
    const { calls, createClient } = models(recorded, async () => ({ text: VERDICTS }));
    const answer = await answerTurn(recorded.input, turn(recorded), { env: JUDGED_ENV, createClient });
    assert.equal(answer.judged, undefined);
    assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5"]);
  }
});

test("the trace holds what the reader ended with and the judge's raw reply, and replays to the same blocks with no model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "judge-gate-"));
  const { createClient } = models(SEGMENTS, async () => ({ text: VERDICTS, usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 } }));
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient, traceDir: dir });
  const judged = await answer.judged!;

  const written = JSON.parse(await readFile(join(dir, SEGMENTS.thread_id, `${SEGMENTS.run_id}.json`), "utf8")) as TurnTrace;
  assert.equal(written.version, 2);
  assert.deepEqual(written.blocks, JSON.parse(JSON.stringify(judged.blocks)));
  assert.deepEqual(written.assertions, JSON.parse(JSON.stringify(judged.assertions)));
  assert.equal(written.judge?.outcome, "replied");
  assert.deepEqual(written.judge?.outcome === "replied" && { text: written.judge.exchange.text, deployment: written.judge.exchange.deployment, usage: written.judge.exchange.usage }, {
    text: VERDICTS,
    deployment: "anthropic/claude-haiku-5-5",
    usage: { input_tokens: 1200, output_tokens: 80 },
  });

  const replayed = await replayRecorded(written);
  assert.equal(text(replayed.blocks), [FIGURES, CONCENTRATED].join("\n\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(replayed.blocks)), written.blocks);
  assert.equal(replayed.judge_input_changed, false);
});

test("a trace recorded before the judge gated inferences replays them hidden: no judge reply was recorded", async () => {
  const replayed = await replayRecorded({ ...SEGMENTS, version: 1 as never, judge: undefined });
  assert.equal(text(replayed.blocks), FIGURES);
  assert.deepEqual(judgeRejections(replayed.assertions), [[6, "error: this trace recorded no judge reply"], [7, "error: this trace recorded no judge reply"]]);
});

test("a recorded reply that answers other inferences than today's is replayed as recorded, and flagged", async () => {
  const recorded = { ...SEGMENTS, judge: { outcome: "replied" as const, exchange: { messages: [{ role: "user", content: "an older answer" }], text: VERDICTS, truncated: false, deployment: "anthropic/claude-haiku-5-5", latency_ms: 4700 } } };
  const replayed = await replayRecorded(recorded);
  assert.equal(text(replayed.blocks), [FIGURES, CONCENTRATED].join("\n\n"));
  assert.equal(replayed.judge_input_changed, true);
});

test("inferences the judge entails show in their assertion order", async () => {
  const { createClient } = models(SEGMENTS, async () => ({ text: '{"verdicts":[{"id":7,"verdict":"entailed"},{"id":6,"verdict":"entailed"}]}' }));
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient });
  assert.equal(text((await answer.judged!).blocks), [FIGURES, CONCENTRATED, CUSHION].join("\n\n"));
});

// A judge that accepts the request and never answers. Its open connection keeps
// the event loop alive; a bare pending promise doesn't (the deadline timers are
// unref'd, and on Node 22 the runner then cancels the test), so the interval
// stands in for it.
function hang(t: { after(fn: () => void): void }): Promise<never> {
  const connection = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(connection));
  return new Promise<never>(() => {});
}
