import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { LlmChatRequest, LlmChatResult } from "../../llm/src/index.ts";
import { answerTurn, type TurnTrace } from "../src/answer-trace.ts";

const trace = async (name: string): Promise<TurnTrace> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`./answer-lab/traces/${name}`, import.meta.url)), "utf8")) as TurnTrace;

const SEGMENTS = await trace("segment-drill-down.json");
const NO_INFERENCE = await trace("cause-in-evidence.json");

const ENV = {
  LLM_CHANNELS: "anthropic",
  LLM_ANTHROPIC_PROTOCOL: "anthropic",
  LLM_ANTHROPIC_API_KEY: "sk-test",
  LLM_ANTHROPIC_MODELS: "claude-sonnet-5-5,claude-haiku-5-5",
  LITELLM_MODEL: "anthropic/claude-sonnet-5-5",
  CHAT_ASSERTION_RENDERING: "1",
};
const JUDGED_ENV = { ...ENV, JUDGE_LITELLM_MODEL: "anthropic/claude-haiku-5-5" };

const VERDICTS = '{"verdicts":[{"id":6,"verdict":"entailed"},{"id":7,"verdict":"not_entailed","reason":"unsupported: no support measures diversification."}]}';

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

test("with JUDGE_LITELLM_MODEL set, the inferences a turn shows are judged after it and added to its trace; its blocks are those with the judge off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shadow-judge-"));
  const judged = models(SEGMENTS, async () => ({ text: VERDICTS, usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 } }));
  const on = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient: judged.createClient, traceDir: dir });
  const plain = models(SEGMENTS, async () => assert.fail("no judge call with the judge off"));
  const off = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: ENV, createClient: plain.createClient });

  assert.deepEqual(on.blocks, off.blocks);
  assert.match(JSON.stringify(on.blocks), /The other four segments provide limited diversification cushion relative to Data Center's dominance\./);
  assert.equal(await off.judged, null);

  const judge = await on.judged;
  assert.deepEqual(judged.calls, ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"]);
  assert.deepEqual({ ...judge, latency_ms: typeof judge?.latency_ms }, {
    deployment: "anthropic/claude-haiku-5-5",
    latency_ms: "number",
    usage: { input_tokens: 1200, output_tokens: 80 },
    verdicts: [
      {
        index: 6,
        verdict: "entailed",
        text: "NVIDIA's revenue is heavily concentrated in Data Center, creating significant single-segment exposure for the consolidated top line.",
      },
      {
        index: 7,
        verdict: "not_entailed",
        reason: "unsupported: no support measures diversification.",
        text: "The other four segments provide limited diversification cushion relative to Data Center's dominance.",
      },
    ],
  });
  const written = JSON.parse(await readFile(join(dir, SEGMENTS.thread_id, `${SEGMENTS.run_id}.json`), "utf8")) as TurnTrace;
  assert.deepEqual(written.judge, judge);
  assert.deepEqual(written.blocks, JSON.parse(JSON.stringify(on.blocks)));
});

test("without JUDGE_LITELLM_MODEL, or with CHAT_JUDGE_SHADOW off, no judge call is made", async () => {
  for (const env of [ENV, { ...JUDGED_ENV, CHAT_JUDGE_SHADOW: "0" }, { ...JUDGED_ENV, CHAT_JUDGE_SHADOW: "off" }]) {
    const { calls, createClient } = models(SEGMENTS, async () => ({ text: VERDICTS }));
    const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env, createClient });
    assert.equal(await answer.judged, null);
    assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5"]);
  }
});

test("a judge that throws fails no turn; its verdicts are errors", async () => {
  const { createClient } = models(SEGMENTS, async () => {
    throw new Error("judge provider down");
  });
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient });
  const plain = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: ENV, createClient });
  assert.deepEqual(answer.blocks, plain.blocks);
  const judge = await answer.judged;
  assert.deepEqual(judge?.verdicts.map(({ index, verdict }) => [index, verdict]), [[6, "error"], [7, "error"]]);
  assert.equal(judge?.verdicts[0]?.reason, "judge call failed: all LLM deployments failed");
});

test("a judge that hangs does not hold the turn: the turn completes first, and the judge ends at its deadline", async (t) => {
  const { createClient } = models(SEGMENTS, () => hang(t));
  let settled = false;
  const answer = await answerTurn(SEGMENTS.input, turn(SEGMENTS), { env: JUDGED_ENV, createClient, judgeDeadlines: { attemptMs: 50, totalMs: 120 } });
  void answer.judged.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.match(JSON.stringify(answer.blocks), /NVIDIA's revenue is heavily concentrated in Data Center/);
  const judge = await answer.judged;
  assert.equal(settled, true);
  assert.deepEqual(judge?.verdicts.map(({ index, verdict }) => [index, verdict]), [[6, "error"], [7, "error"]]);
});

test("a turn that shows no inference makes no judge call: none rendered, or prose shown", async () => {
  const cases: Array<[TurnTrace, typeof JUDGED_ENV]> = [
    [NO_INFERENCE, JUDGED_ENV],
    // Its inferences are listed but, rendering off, the reader sees prose.
    [SEGMENTS, { ...JUDGED_ENV, CHAT_ASSERTION_RENDERING: "0" }],
  ];
  for (const [recorded, env] of cases) {
    const { calls, createClient } = models(recorded, async () => ({ text: VERDICTS }));
    const answer = await answerTurn(recorded.input, turn(recorded), { env, createClient });
    assert.equal(await answer.judged, null);
    assert.deepEqual(calls, ["anthropic/claude-sonnet-5-5"]);
  }
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
