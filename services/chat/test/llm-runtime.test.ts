import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LlmProviderError, LlmRouterError } from "../../llm/src/index.ts";
import {
  ANSWER_DEADLINES,
  answerContext,
  composeAnalystBlocksWithLlm,
  TITLE_DEADLINES,
  createLlmThreadTitleModel,
} from "../src/llm-runtime.ts";

const BASE_ENV = {
  LLM_CHANNELS: "openai",
  LLM_OPENAI_PROTOCOL: "openai",
  LLM_OPENAI_MODELS: "gpt-4.1",
  LITELLM_MODEL: "openai/gpt-4.1",
};

test("createLlmThreadTitleModel delegates to the shared router", async () => {
  const calls: string[] = [];
  const model = createLlmThreadTitleModel({
    env: BASE_ENV,
    createClient: () => async (_deployment, request) => {
      calls.push(request.messages.map((message) => `${message.role}:${message.content}`).join("\n"));
      return { text: "Apple Margin Watch" };
    },
  });

  const title = await model({
    userIntent: "Why did Apple sell off?",
    assistantText: "Margins compressed after guidance.",
  });

  assert.equal(title, "Apple Margin Watch");
  assert.match(calls[0], /Why did Apple sell off\?/);
  assert.match(calls[0], /Margins compressed/);
});

test("createLlmThreadTitleModel gives reasoning models enough output budget", async () => {
  let observedMaxTokens: number | undefined;
  const model = createLlmThreadTitleModel({
    env: BASE_ENV,
    createClient: () => async (_deployment, request) => {
      observedMaxTokens = request.maxTokens;
      return { text: "Apple Margin Watch" };
    },
  });

  await model({ userIntent: "Why did Apple sell off?", assistantText: "Margins compressed." });

  assert.ok((observedMaxTokens ?? 0) >= 256, `expected a generous title budget for reasoning models, got ${observedMaxTokens}`);
});

test("composeAnalystBlocksWithLlm gives reasoning models room to think and still answer", async () => {
  let observedMaxTokens: number | undefined;
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    createClient: () => async (_deployment, request) => {
      observedMaxTokens = request.maxTokens;
      return { text: "Apple's revenue rose." };
    },
  });

  // At 800, qwen3.8-max spent the whole budget reasoning and returned no text (#124).
  assert.ok((observedMaxTokens ?? 0) >= 4096, `expected an answer budget that survives reasoning, got ${observedMaxTokens}`);
});

test("composeAnalystBlocksWithLlm returns original blocks when no deployment is configured", async () => {
  const blocks = [richTextBlock("Deterministic note")];
  const result = await composeAnalystBlocksWithLlm({
    env: {},
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks,
    toolCalls: [],
    createClient: () => {
      throw new Error("client should not be created");
    },
  });

  assert.equal(result, blocks);
});

test("composeAnalystBlocksWithLlm rewrites the first rich text block", async () => {
  const result = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [{
      tool_call_id: "tool-1",
      tool_name: "load_evidence",
      status: "ok",
      bundle_id: "single_subject_analysis",
      arguments: { query: "Analyze AAPL" },
      result: { evidence_status: "available" },
    }],
    createClient: () => async (_deployment, request) => {
      // The question goes in; the raw tool call does not (#181).
      assert.match(request.messages[1]?.content ?? "", /"question":"Analyze AAPL"/);
      assert.doesNotMatch(request.messages[1]?.content ?? "", /load_evidence/);
      return { text: "LLM-grounded note" };
    },
  });

  assert.notEqual(result[0], undefined);
  assert.deepEqual(result[0]?.segments, [
    { type: "text", text: "LLM-grounded note" },
  ]);
});

test("composeAnalystBlocksWithLlm instructs the analyst to caveat stale data", async () => {
  let systemPrompt = "";
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    createClient: () => async (_deployment, request) => {
      systemPrompt = request.messages[0]?.content ?? "";
      return { text: "answer" };
    },
  });

  // The stale signals (quote.stale, fact_recency.stale) are inert unless the
  // prompt tells the analyst to honor them.
  assert.match(systemPrompt, /stale/i);
  assert.match(systemPrompt, /fact_recency|out of date|age_days/i);
});

const TWO_DEPLOYMENTS = {
  LLM_CHANNELS: "openai,deepseek",
  LLM_OPENAI_PROTOCOL: "openai",
  LLM_OPENAI_MODELS: "gpt-4.1",
  LLM_DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
  LLM_DEEPSEEK_MODELS: "deepseek-chat",
  LITELLM_MODEL: "openai/gpt-4.1",
  LITELLM_FALLBACK_MODELS: "deepseek/deepseek-chat",
};

test("an answer model that hangs falls back at its attempt deadline (#184)", async (t) => {
  const calls: string[] = [];
  const startedAt = Date.now();
  const result = await composeAnalystBlocksWithLlm({
    env: TWO_DEPLOYMENTS,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    deadlines: { attemptMs: 50, totalMs: 5_000 },
    createClient: () => async (deployment) => {
      calls.push(deployment.model);
      // The primary accepts the request and never answers.
      if (calls.length === 1) return hang(t);
      return { text: "fallback note" };
    },
  });

  assert.deepEqual(calls, ["gpt-4.1", "deepseek-chat"]);
  assert.equal((result[0].segments as Array<{ text: string }>)[0].text, "fallback note");
  assert.ok(Date.now() - startedAt < 2_000, "the hang cost about the attempt deadline");
});

test("when every model hangs, the answer call ends with an error at its deadline (#184)", async (t) => {
  const startedAt = Date.now();
  await assert.rejects(composeAnalystBlocksWithLlm({
    env: TWO_DEPLOYMENTS,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    deadlines: { attemptMs: 50, totalMs: 5_000 },
    createClient: () => () => hang(t),
  }), /all LLM deployments failed/);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("only attempts the total can finish are made, so a failure names each timeout (#184)", async (t) => {
  // Two 60 ms attempts can't finish in 100 ms: one is made, and it ends on its own deadline.
  const calls: string[] = [];
  await assert.rejects(composeAnalystBlocksWithLlm({
    env: TWO_DEPLOYMENTS,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    deadlines: { attemptMs: 60, totalMs: 100 },
    createClient: () => (deployment) => {
      calls.push(deployment.model);
      return hang(t);
    },
  }), (error) => error instanceof LlmRouterError && error.attempts.length === 1 && error.attempts[0]!.code === "timeout");
  assert.deepEqual(calls, ["gpt-4.1"]);
});

test("deadlines that leave no room for a whole attempt are rejected before any model call", async () => {
  let called = 0;
  for (const deadlines of [{ attemptMs: 100, totalMs: 100 }, { attemptMs: 200, totalMs: 100 }, { attemptMs: 0, totalMs: 100 }]) {
    await assert.rejects(composeAnalystBlocksWithLlm({
      env: TWO_DEPLOYMENTS,
      context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
      blocks: [richTextBlock("Deterministic note")],
      toolCalls: [],
      deadlines,
      createClient: () => () => {
        called += 1;
        return { text: "unexpected" };
      },
    }), RangeError, JSON.stringify(deadlines));
  }
  assert.equal(called, 0);
});

test("an exact fit leaves the last attempt out, so the total never cuts one", async (t) => {
  // 2 × 60 ms equals the 120 ms total: the second attempt would race the total, so one is made.
  const calls: string[] = [];
  await assert.rejects(composeAnalystBlocksWithLlm({
    env: TWO_DEPLOYMENTS,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    deadlines: { attemptMs: 60, totalMs: 120 },
    createClient: () => (deployment) => {
      calls.push(deployment.model);
      return hang(t);
    },
  }), (error) => error instanceof LlmRouterError && error.attempts.length === 1);
  assert.deepEqual(calls, ["gpt-4.1"]);
});

test("the last attempt gets only what is left of the total, so it still fails as a router timeout", async (t) => {
  // 2 × 50 ms in 101 ms leaves 1 ms of headroom; routing overhead can use it up, so the
  // second attempt's deadline comes from the remaining budget rather than racing a total timer.
  const startedAt = Date.now();
  await assert.rejects(composeAnalystBlocksWithLlm({
    env: TWO_DEPLOYMENTS,
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    deadlines: { attemptMs: 50, totalMs: 101 },
    createClient: () => () => hang(t),
  }), (error) => error instanceof LlmRouterError && error.attempts.length === 2 && error.attempts.every((a) => a.code === "timeout"));
  assert.ok(Date.now() - startedAt < 1_000, "the chain ends near its total");
});

test("the production deadlines bound the answer and the title calls", () => {
  for (const deadlines of [ANSWER_DEADLINES, TITLE_DEADLINES]) {
    // A primary and its fallback both fit, with headroom, so the total never cuts an attempt.
    assert.ok(deadlines.attemptMs > 0 && 2 * deadlines.attemptMs < deadlines.totalMs);
  }
  assert.ok(ANSWER_DEADLINES.totalMs <= 180_000, "a hung provider costs a user minutes, not the 516 s of #184");
  assert.ok(TITLE_DEADLINES.attemptMs < ANSWER_DEADLINES.attemptMs);
});

test("the answer is asked for an analyst's view: takeaway, trend, strengths, counterpoint, gaps (#179)", async () => {
  let systemPrompt = "";
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze NVDA", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    createClient: () => async (_deployment, request) => {
      systemPrompt = request.messages[0]?.content ?? "";
      return { text: "answer" };
    },
  });
  for (const part of [/takeaway/i, /trend across every period/i, /strong or weak/i, /counterpoint grounded in the data/i, /cannot tell/i, /concentrated in one segment/i, /does not answer the question/i, /do not analyze other figures\s+in its place/i]) {
    assert.match(systemPrompt, part);
  }
  // Context comes from the data only, and the existing rules stay.
  assert.match(systemPrompt, /never add facts, numbers, or events that are not in the tool context/);
  assert.match(systemPrompt, /never compute new figures/);
  // Each sentence with a figure names its company: the guard does not carry
  // "Its" across sentences (#240, #142).
  assert.match(systemPrompt, /never begin it with "Its" or "Their"/);
  // A magnitude comparison in words is a computation too, and a cause needs data (#228).
  assert.match(systemPrompt, /magnitude comparison between figures is a computation too, even in words/);
  assert.match(systemPrompt, /only the direction/);
  // Two figures side by side do not "show" their ratio (#228 review).
  assert.match(systemPrompt, /two figures side by side do not state one/);
  assert.match(systemPrompt, /never state one in words/);
  assert.match(systemPrompt, /never state a cause the data does not show/);
  // The allowed forms of a cause, and the hypothesis label the guard keeps (#261).
  assert.match(systemPrompt, /management attribution from a cited claim/);
  // Candidate causes go in labelled hypotheses, not inside a gap sentence (2026-10-08 eval).
  assert.match(systemPrompt, /never as\s+a list of candidate causes inside a sentence about what the data cannot tell/);
  assert.match(systemPrompt, /> \*\*Unverified hypothesis \(low\|medium\|high confidence\):\*\* <one explanation>, given <a figure or metric shown in this answer>/);
  // The fact blocks render after the narrative, so nothing is "shown above" (#262 review).
  assert.doesNotMatch(systemPrompt, /shown above/);
  assert.match(systemPrompt, /stale/);
  // The no-keys golden replay matches on the opening sentence.
  assert.match(systemPrompt, /^Write a concise investment research answer/);
});

test("composeAnalystBlocksWithLlm falls back through shared router deployments", async () => {
  const calls: string[] = [];
  const result = await composeAnalystBlocksWithLlm({
    env: {
      LLM_CHANNELS: "openai,deepseek",
      LLM_OPENAI_PROTOCOL: "openai",
      LLM_OPENAI_MODELS: "gpt-4.1",
      LLM_DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      LLM_DEEPSEEK_MODELS: "deepseek-chat",
      LITELLM_MODEL: "openai/gpt-4.1",
      LITELLM_FALLBACK_MODELS: "deepseek/deepseek-chat",
    },
    context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
    blocks: [richTextBlock("Deterministic note")],
    toolCalls: [],
    createClient: () => async (deployment) => {
      calls.push(`${deployment.channel}/${deployment.model}`);
      if (calls.length === 1) throw new LlmProviderError("provider_failed", "primary down");
      return { text: "fallback note" };
    },
  });

  assert.deepEqual(calls, ["openai/gpt-4.1", "deepseek/deepseek-chat"]);
  assert.deepEqual(result[0]?.segments, [{ type: "text", text: "fallback note" }]);
});

test("createLlmThreadTitleModel reloads LLM_SETTINGS_ENV_FILE between calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-llm-env-"));
  const envFile = join(dir, ".env.dev");
  await writeFile(envFile, [
    "LLM_CHANNELS=openai",
    "LLM_OPENAI_PROTOCOL=openai",
    "LLM_OPENAI_MODELS=gpt-4.1",
    "LITELLM_MODEL=openai/gpt-4.1",
    "",
  ].join("\n"));
  const seen: string[] = [];
  const model = createLlmThreadTitleModel({
    env: { LLM_SETTINGS_ENV_FILE: envFile },
    createClient: () => async (deployment) => {
      seen.push(`${deployment.channel}/${deployment.model}`);
      return { text: deployment.model };
    },
  });

  assert.equal(await model({ assistantText: "First answer" }), "gpt-4.1");
  await writeFile(envFile, [
    "LLM_CHANNELS=openai",
    "LLM_OPENAI_PROTOCOL=openai",
    "LLM_OPENAI_MODELS=o3",
    "LITELLM_MODEL=openai/o3",
    "",
  ].join("\n"));
  assert.equal(await model({ assistantText: "Second answer" }), "o3");
  assert.deepEqual(seen, ["openai/gpt-4.1", "openai/o3"]);
});

function richTextBlock(text: string): Record<string, unknown> {
  return {
    id: "block-1",
    kind: "rich_text",
    title: "Research note",
    segments: [{ type: "text", text }],
  };
}

const NARRATIVE_BLOCK = {
  id: "narrative-1",
  kind: "rich_text",
  segments: [{ type: "text", text: "placeholder" }],
};
const FACT_BLOCKS = [{
  id: "metric-row-1",
  kind: "metric_row",
  title: "Latest quarter (Q4 2026)",
  items: [{ label: "Revenue", value_ref: "fact-1", format: "$62.1B" }],
}];

async function composeWithReply(reply: string, subjectLabels?: ReadonlyArray<string>) {
  let prompt = "";
  let removed: ReadonlyArray<string> = [];
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze NVDA", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: FACT_BLOCKS,
    ...(subjectLabels ? { subjectLabels } : {}),
    createClient: () => async (_deployment, request) => {
      prompt = request.messages.map((message) => message.content).join("\n");
      return { text: reply };
    },
    onNarrativeRemoved: (sentences) => {
      removed = sentences;
    },
  });
  const text = (blocks[0].segments as Array<{ text: string }>)[0].text;
  return { text, prompt, removed };
}

test("a single-company hypothesis's basis may name the answer's subject, however the hypothesis opens (2026-10-08 eval)", async () => {
  const reply = "> **Unverified hypothesis (medium confidence):** A one-time charge may explain the dip, given NVDA's revenue of $62.1B.";
  assert.deepEqual((await composeWithReply(reply, ["NVDA"])).removed, []);
  // Without the subject, or naming another company, the basis is still unknown.
  assert.equal((await composeWithReply(reply)).removed.length, 1);
  assert.equal((await composeWithReply(reply.replace("NVDA's", "TSLA's"), ["NVDA"])).removed.length, 1);
});

test("a single-company answer may carry a labelled hypothesis resting on a displayed metric (#262 review)", async () => {
  const reply = [
    "NVDA's revenue reached $62.1B in Q4 2026.",
    "",
    "> **Unverified hypothesis (medium confidence):** NVDA's revenue may reflect Data Center demand, given its revenue of $62.1B.",
  ].join("\n");
  const { text, removed } = await composeWithReply(reply);
  assert.deepEqual({ text, removed }, { text: reply, removed: [] });
  // Naming the company in its basis, as the prompt asks of every figure (#262 review).
  const named = "> **Unverified hypothesis (low confidence):** NVDA's revenue may reflect pricing power, given NVDA's revenue of $62.1B.";
  assert.deepEqual(await composeWithReply(named).then(({ text, removed }) => ({ text, removed })), { text: named, removed: [] });
  // Another company's figure is no basis, even when its number is shown.
  const other = "> **Unverified hypothesis (low confidence):** NVDA's revenue may reflect pricing power, given TSLA's revenue of $62.1B.";
  assert.deepEqual((await composeWithReply(other)).removed, ["NVDA's revenue may reflect pricing power, given TSLA's revenue of $62.1B."]);
});

test("a replayed reply quoting a figure the user is not shown has that sentence stripped", async () => {
  const { text, prompt, removed } = await composeWithReply(
    "Revenue reached $62.1B in Q4 2026. That is 38% growth year over year.",
  );
  assert.equal(text, "Revenue reached $62.1B in Q4 2026.");
  // The dropped sentence is reported, so an eval can count guarded drops (#144).
  assert.deepEqual(removed, ["That is 38% growth year over year."]);
  // The model is told which figures it may quote.
  assert.match(prompt, /evidence_packet/);
  assert.match(prompt, /\$62\.1B/);
});

test("a reply with no supported sentence falls back to a pointer at the cited figures", async () => {
  const { text } = await composeWithReply("Revenue grew 45%. EPS hit $3.10.");
  assert.match(text, /select any value to see its source/);
  assert.doesNotMatch(text, /45|3\.10/);
});

async function composeWith(result: { text: string; truncated?: boolean }, factBlocks?: ReadonlyArray<Record<string, unknown>>) {
  let reasoning: string | undefined;
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "What changed in NVDA's gross margin?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    ...(factBlocks ? { factBlocks } : {}),
    createClient: () => async (_deployment, request) => {
      reasoning = request.reasoning;
      return result;
    },
  });
  return { text: (blocks[0].segments as Array<{ text: string }>)[0].text, reasoning };
}

test("an answer cut off at the token limit is never shown; the figures pointer is", async () => {
  // The #124 baseline showed "...The displayed figures do not include a Q".
  const { text, reasoning } = await composeWith({ text: "Gross margin fell. The displayed figures do not include a Q", truncated: true }, FACT_BLOCKS);
  assert.match(text, /select any value to see its source/);
  assert.equal(reasoning, "low", "the answer asks for low reasoning effort");
});

test("an empty answer replaces the placeholder line instead of leaving it on screen", async () => {
  assert.match((await composeWith({ text: "" }, FACT_BLOCKS)).text, /select any value to see its source/);
  // No figures to point to: say there's no answer rather than show the placeholder.
  const { text } = await composeWith({ text: "  " });
  assert.notEqual(text, "placeholder");
  assert.match(text, /No written answer is available/);
});

test("a thread title cut off at the token limit falls back instead of being saved", async () => {
  const model = createLlmThreadTitleModel({
    env: BASE_ENV,
    createClient: () => async () => ({ text: "Apple Margin Wa", truncated: true }),
  });
  await assert.rejects(async () => model({ userIntent: "Why did Apple sell off?", assistantText: "Margins compressed." }), /cut off/);
});

test("without fact blocks the narrative is passed through unguarded, as before", async () => {
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Summarize demand", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    createClient: () => async () => ({ text: "Demand rose 12% per the cited note." }),
  });
  assert.equal((blocks[0].segments as Array<{ text: string }>)[0].text, "Demand rose 12% per the cited note.");
});

const COMPARISON_BLOCKS = [{
  id: "comparison-1",
  kind: "metrics_comparison",
  title: "Side by side (latest fiscal year)",
  subjects: [{ kind: "issuer", id: "issuer-nvda" }, { kind: "issuer", id: "issuer-amd" }],
  subject_labels: ["NVDA", "AMD"],
  metrics: ["Revenue", "Gross Margin"],
  cells: [
    [{ value_ref: "f1", format: "$130.5B" }, { value_ref: "f2", format: "74.6%" }],
    [{ value_ref: "f3", format: "$25.8B" }, { value_ref: "f4", format: "49.2%" }],
  ],
}];

async function compareWithReply(reply: string) {
  let prompt = "";
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: COMPARISON_BLOCKS,
    createClient: () => async (_deployment, request) => {
      prompt = request.messages.map((message) => message.content).join("\n");
      return { text: reply };
    },
  });
  return { text: (blocks[0].segments as Array<{ text: string }>)[0].text, prompt };
}

test("the composer reports the deployment that wrote the answer (#183)", async () => {
  const answered: string[] = [];
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Summarize demand", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    createClient: () => async () => ({ text: "Demand rose." }),
    onAnswered: (deployment) => answered.push(deployment),
  });
  assert.deepEqual(answered, ["openai/gpt-4.1"]);
});

test("a fallback sentence shown in place of the answer was written by no model (#183)", async () => {
  const answeredBy = async (reply: { text: string; truncated?: boolean }, factBlocks?: ReadonlyArray<Record<string, unknown>>) => {
    const answered: string[] = [];
    await composeAnalystBlocksWithLlm({
      env: BASE_ENV,
      context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
      blocks: [NARRATIVE_BLOCK],
      toolCalls: [],
      factBlocks,
      createClient: () => async () => reply,
      onAnswered: (deployment) => answered.push(deployment),
    });
    return answered;
  };
  assert.deepEqual(await answeredBy({ text: "" }), [], "empty");
  assert.deepEqual(await answeredBy({ text: "Demand rose and", truncated: true }), [], "cut off");
  // Every sentence quotes a figure the user is not shown: the guard drops them all.
  assert.deepEqual(await answeredBy({ text: "NVDA's margin is 99.9%." }, COMPARISON_BLOCKS), [], "all guarded");
  assert.deepEqual(await answeredBy({ text: "NVDA is larger." }, COMPARISON_BLOCKS), ["openai/gpt-4.1"], "kept");
});

test("the answer model sees a compact context, not raw tool JSON (#181)", async () => {
  let prompt = "";
  const usage: unknown[] = [];
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    bundle_id: "peer_comparison",
    status: "ok",
    arguments: { query: "Compare NVDA with AMD" },
    result: {
      evidence_status: "available",
      manifest_contribution: { subject_refs: [], claim_refs: ["c1"] },
      structured_context: {
        quote: { ticker: "NVDA", price: 178.4, as_of: "2026-09-01T00:00:00.000Z", stale: true, provider: "polygon", source_id: "s" },
        facts: Array.from({ length: 24 }, (_, i) => ({ fact_id: `f${i}`, metric_key: "revenue", value_num: i })),
        fact_recency: { latest_as_of: "2026-08-01T00:00:00.000Z", age_days: 31, stale: false },
      },
      evidence: {
        claims: [{ claim_id: "c1", source_id: "s-claim", text_canonical: "NVIDIA guided data-center revenue higher.", predicate: "guidance.change", polarity: "positive", effective_time: "2025-11-19T00:00:00.000Z", published_at: "2025-11-20T00:00:00.000Z" }],
        truncated: true,
      },
    },
  } as never;
  const gap = { kind: "rich_text", segments: [{ type: "text", text: "Year-to-date price performance is not shown: AMD has no prices from before 2026." }] };
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [toolCall],
    factBlocks: [...COMPARISON_BLOCKS, gap],
    createClient: () => async (_deployment, request) => {
      prompt = request.messages.at(-1)!.content;
      return { text: "NVDA is larger.", usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020, reasoningTokens: 80 } };
    },
    onUsage: (reported) => usage.push(reported),
  });
  const context = JSON.parse(prompt) as Record<string, unknown>;
  assert.deepEqual(Object.keys(context).sort(), ["conversation", "evidence_packet", "question"].sort());
  const packet = context.evidence_packet as Record<string, unknown>;
  // The figures carry short packet ids; the facts behind them stay server-side (#207).
  assert.deepEqual((packet.figures as Array<{ id: string }>).map((figure) => figure.id), ["F1", "F2", "F3", "F4"]);
  // Each claim keeps its dates, so a past claim is not read as current, and a
  // short id: its claim and source ids stay server-side (#207).
  assert.deepEqual(packet.claims, [{
    id: "C1",
    text: "NVIDIA guided data-center revenue higher.",
    predicate: "guidance.change",
    stance: "supporting",
    effective_time: "2025-11-19T00:00:00.000Z",
    published_at: "2025-11-20T00:00:00.000Z",
  }]);
  assert.equal(packet.claims_truncated, true);
  assert.deepEqual(packet.gaps, ["Year-to-date price performance is not shown: AMD has no prices from before 2026."]);
  assert.deepEqual(packet.staleness, {
    quote: [{ ticker: "NVDA", as_of: "2026-09-01T00:00:00.000Z", stale: true }],
    fact_recency: [{ latest_as_of: "2026-08-01T00:00:00.000Z", age_days: 31, stale: false }],
  });
  // None of the raw tool JSON: no facts, prices, ids, or the placeholder block.
  for (const absent of ["fact_id", "178.4", "manifest_contribution", "tool_calls", "existing_blocks", "bundle_id"]) {
    assert.ok(!prompt.includes(absent), absent);
  }
  assert.deepEqual(usage, [{ input_tokens: 900, output_tokens: 120, reasoning_tokens: 80 }]);
});

test("with no figures shown, the model still gets the evidence, compactly, as available_data (#181)", async () => {
  let prompt = "";
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    bundle_id: "single_subject_analysis",
    status: "ok",
    result: {
      evidence_status: "available",
      structured_context: {
        quote: { ticker: "AAPL", price: 231.6, change_pct: 0.0078, currency: "USD", as_of: "2026-09-01T00:00:00.000Z", stale: false, session_state: "closed", delay_class: "eod", source_id: "s" },
        facts: [
          { fact_id: "f1", metric_key: "revenue", display_name: "Revenue", value_num: 416.161, scale: 1e9, unit: "currency", currency: "USD", fiscal_year: 2025, fiscal_period: "FY", as_of: "2025-10-31T00:00:00.000Z", source_id: "s", coverage_level: "full" },
          { fact_id: "f2", metric_key: "net_income", display_name: "Net income", value_num: 25, scale: 1e9, unit: "currency", currency: "USD", fiscal_year: 2026, fiscal_period: "Q1", as_of: "2026-01-30T00:00:00.000Z", source_id: "s", coverage_level: "partial" },
        ],
      },
    },
  } as never;
  const run = async (factBlocks?: ReadonlyArray<Record<string, unknown>>, availableData?: boolean) => {
    await composeAnalystBlocksWithLlm({
      env: BASE_ENV,
      context: { userIntent: "Analyze AAPL", bundleId: "single_subject_analysis" },
      blocks: [NARRATIVE_BLOCK],
      toolCalls: [toolCall],
      factBlocks,
      ...(availableData === undefined ? {} : { availableData }),
      createClient: () => async (_deployment, request) => {
        prompt = request.messages.at(-1)!.content;
        return { text: "AAPL trades at $231.6." };
      },
    });
    return JSON.parse(prompt) as Record<string, unknown>;
  };
  const packetOf = (context: Record<string, unknown>) => context.evidence_packet as Record<string, unknown>;
  assert.deepEqual(packetOf(await run()).available_data, {
    quotes: [{ ticker: "AAPL", price: 231.6, change: "+0.78%", currency: "USD", as_of: "2026-09-01T00:00:00.000Z", session_state: "closed", delay_class: "eod" }],
    facts: [
      { metric: "Revenue", value: 416161000000, unit: "currency", currency: "USD", period: "FY 2025", as_of: "2025-10-31T00:00:00.000Z" },
      // A partially covered period says so.
      { metric: "Net income", value: 25000000000, unit: "currency", currency: "USD", period: "Q1 2026", as_of: "2026-01-30T00:00:00.000Z", coverage: "partial" },
    ],
  });
  assert.ok(!prompt.includes("fact_id") && !prompt.includes('"source_id"'), "still compact: no ids");
  // With figures shown, only those may be quoted: no available_data.
  assert.equal("available_data" in packetOf(await run(COMPARISON_BLOCKS)), false);
  // A turn asking only for a metric no reader serves gets the named gap, not
  // other facts it could offer in that metric's place (#206).
  const gap = { kind: "rich_text", segments: [{ type: "text", text: "Free cash flow is not available for AAPL in this data, so no other figure is shown in its place." }] };
  const withheld = await run([gap], false);
  assert.equal("available_data" in packetOf(withheld), false);
  assert.deepEqual(packetOf(withheld).gaps, [gap.segments[0]!.text]);
});

test("blocks that show no figures (a gap note) leave the answer unguarded, like no blocks (#181)", async () => {
  const gap = { kind: "rich_text", segments: [{ type: "text", text: "Year-to-date price performance is not shown." }] };
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "How is AAPL doing YTD?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [gap],
    createClient: () => async () => ({ text: "AAPL trades at $231.6 per the latest quote." }),
  });
  assert.equal((blocks[0].segments as Array<{ text: string }>)[0].text, "AAPL trades at $231.6 per the latest quote.");
});

test("with no figures shown, a stated cause still goes; figures and gaps stay (#263)", async () => {
  let removed: ReadonlyArray<string> = [];
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "How is AAPL doing?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    createClient: () => async () => ({
      text: "AAPL trades at $231.6. The move could reflect a one-time charge. The data does not show why.",
    }),
    onNarrativeRemoved: (sentences) => {
      removed = sentences;
    },
  });
  assert.equal((blocks[0].segments as Array<{ text: string }>)[0].text, "AAPL trades at $231.6. The data does not show why.");
  assert.deepEqual(removed, ["The move could reflect a one-time charge."]);
});

test("the prompt asks for a missing period in words, not by its year (#264)", async () => {
  let system = "";
  await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze NVDA", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    createClient: () => async (_deployment, request) => {
      system = request.messages[0]!.content;
      return { text: "NVDA grew." };
    },
  });
  assert.match(system, /describe a missing period in words \("no prior-year revenue"\), never by its year or number/);
});

test("a turn showing only a price chart stays guarded against returns it does not show (#181)", async () => {
  const chart = {
    kind: "perf_comparison",
    title: "Price performance",
    default_range: "YTD 2026: 2025-12-31 close to 2026-08-31",
    series: [{ name: "NVDA", points: [{ x: "2025-12-31", y: 0 }, { x: "2026-08-31", y: 12.5 }] }],
  };
  const narrate = async (text: string) => {
    const composed = await composeAnalystBlocksWithLlm({
      env: BASE_ENV,
      context: { userIntent: "How has NVDA done?", bundleId: "peer_comparison" },
      blocks: [NARRATIVE_BLOCK],
      toolCalls: [],
      factBlocks: [chart],
      createClient: () => async () => ({ text }),
    });
    return (composed[0].segments as Array<{ text: string }>)[0].text;
  };
  assert.equal(await narrate("NVDA returned 12.5% over the window."), "NVDA returned 12.5% over the window.");
  assert.notEqual(await narrate("NVDA returned 40.0% over the window."), "NVDA returned 40.0% over the window.");
  // The window's dates are no returns: its day and month digits do not pass.
  assert.notEqual(await narrate("NVDA returned 31% over the window."), "NVDA returned 31% over the window.");
  assert.notEqual(await narrate("NVDA returned 8% over the window."), "NVDA returned 8% over the window.");
  assert.equal(
    await narrate("NVDA returned 12.5% from December 2025 to August 2026."),
    "NVDA returned 12.5% from December 2025 to August 2026.",
  );
});

test("a claim the model dates from its effective time keeps its sentence (#181)", async () => {
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    bundle_id: "peer_comparison",
    status: "ok",
    result: { evidence: { claims: [{ claim_id: "c1", text_canonical: "NVIDIA guided revenue higher.", effective_time: "2025-11-19T00:00:00.000Z" }] } },
  } as never;
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [toolCall],
    factBlocks: COMPARISON_BLOCKS,
    createClient: () => async () => ({ text: "In November 2025, NVIDIA guided revenue higher." }),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0].text, "In November 2025, NVIDIA guided revenue higher.");
});

test("a claim's date supports its month and year, never its day or time as a figure (#181)", async () => {
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    bundle_id: "peer_comparison",
    status: "ok",
    result: { evidence: { claims: [{ claim_id: "c1", text_canonical: "NVIDIA guided revenue higher.", effective_time: "2025-11-19T00:00:00.000Z" }] } },
  } as never;
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [toolCall],
    factBlocks: COMPARISON_BLOCKS,
    // 19 is only the claim's day: an invented margin must not survive on it.
    createClient: () => async () => ({ text: "Margins reached 19% last year. NVDA is larger." }),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0].text, "NVDA is larger.");
});

test("the model sees each comparison figure with the company and metric it belongs to", async () => {
  const { prompt } = await compareWithReply("NVDA leads.");
  assert.ok(
    prompt.includes(JSON.stringify({ id: "F4", company: "AMD", metric: "Gross Margin", value: "49.2%", shown_in: "Side by side (latest fiscal year)" })),
    prompt,
  );
});

test("a replayed reply crediting AMD's margin to NVIDIA loses that sentence; the correct one is kept", async () => {
  const wrong = await compareWithReply("NVDA's gross margin is 49.2%. NVDA is larger.");
  assert.equal(wrong.text, "NVDA is larger.");
  const right = await compareWithReply("AMD's gross margin is 49.2%. NVDA is larger.");
  assert.equal(right.text, "AMD's gross margin is 49.2%. NVDA is larger.");
});

function fiscalComparison(nvda: { year: number; end: string; revenue: string }) {
  return [{
    kind: "metrics_comparison",
    title: "Side by side (fiscal years)",
    subject_labels: ["NVDA", "AAPL"],
    metrics: ["Revenue"],
    cells: [[{ value_ref: "f1", format: nvda.revenue }], [{ value_ref: "f2", format: "$416.2B" }]],
    data_ref: {
      params: {
        fact_bindings: [
          { fact_id: "f1", fiscal_year: nvda.year, fiscal_period: "FY", period_end: nvda.end },
          { fact_id: "f2", fiscal_year: 2025, fiscal_period: "FY", period_end: "2025-09-27" },
        ],
      },
    },
  }];
}

async function narrate(factBlocks: ReadonlyArray<Record<string, unknown>>, reply: string) {
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA's and AAPL's revenue", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks,
    createClient: () => async () => ({ text: reply }),
  });
  return (composed[0].segments as Array<{ text: string }>)[0].text;
}

test("a fiscal year is credited to the company it belongs to, unless every company shares it (#180)", async () => {
  // Latest years differ: 2026 is NVDA's, 2025 AAPL's.
  const latest = fiscalComparison({ year: 2026, end: "2026-01-25", revenue: "$209.9B" });
  assert.equal(await narrate(latest, "NVDA's FY2025 revenue was $209.9B. NVDA is smaller."), "NVDA is smaller.");
  const right = "NVDA's FY2026 revenue was $209.9B and AAPL's FY2025 revenue was $416.2B.";
  assert.equal(await narrate(latest, right), right);
  // Both FY2025: the year needs no company.
  const shared = fiscalComparison({ year: 2025, end: "2025-01-26", revenue: "$130.5B" });
  const opening = "In fiscal 2025, NVDA's revenue was $130.5B.";
  assert.equal(await narrate(shared, opening), opening);
});

test("a chart's window does not make every company's fiscal year shared (#244)", async () => {
  const latest = fiscalComparison({ year: 2026, end: "2026-01-25", revenue: "$209.9B" });
  const chart = {
    kind: "perf_comparison",
    title: "Price return YTD 2026 (split-adjusted, excluding dividends)",
    default_range: "YTD 2026: 2025-12-31 close to 2026-08-31 close",
    series: [{ name: "NVDA", points: [{ y: 0 }, { y: 6.6 }] }, { name: "AAPL", points: [{ y: 0 }, { y: 6.05 }] }],
  };
  assert.equal(await narrate([...latest, chart], "NVDA's FY2025 revenue was $209.9B. NVDA is smaller."), "NVDA is smaller.");
  const right = "NVDA's FY2026 revenue was $209.9B, and its price return was 6.6% from December 2025 to August 2026.";
  assert.equal(await narrate([...latest, chart], right), right);
});

test("the chart window's dates reach the guard, so a narrative may write their day (#240)", async () => {
  const latest = fiscalComparison({ year: 2026, end: "2026-01-25", revenue: "$209.9B" });
  const chart = {
    kind: "perf_comparison",
    title: "Price return YTD 2026 (split-adjusted, excluding dividends)",
    default_range: "YTD 2026: 2025-12-31 close to 2026-08-31 close",
    series: [{ name: "NVDA", points: [{ y: 0 }, { y: 6.6 }] }, { name: "AAPL", points: [{ y: 0 }, { y: 6.05 }] }],
  };
  const window = "NVDA's price return was 6.6% from the December 31, 2025 close to the August 31, 2026 close.";
  assert.equal(await narrate([...latest, chart], window), window);
});

test("the guard gets each figure's metric, so a possessive can name it (#240)", async () => {
  // A shared year attaches no one: only the metric credits AAPL its revenue.
  const shared = fiscalComparison({ year: 2025, end: "2025-01-26", revenue: "$130.5B" });
  const kept = "NVDA's revenue was $130.5B versus AAPL's FY2025 revenue of $416.2B.";
  assert.equal(await narrate(shared, kept), kept);
});

// A provider that accepts the request and never answers. Its open connection keeps
// the event loop alive; a bare pending promise doesn't (AbortSignal.timeout's timer is
// unref'd), so the interval stands in for it.
function hang(t: { after(fn: () => void): void }): Promise<never> {
  const connection = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(connection));
  return new Promise<never>(() => {});
}

test("an answer whose every sentence goes beside a gap note falls back without pointing to figures (#263)", async () => {
  const gap = { kind: "rich_text", segments: [{ type: "text", text: "Free cash flow is not available for AMD in this data." }] };
  const blocks = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "What is AMD's free cash flow?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [gap],
    createClient: () => async () => ({ text: "It fell due to heavy spending." }),
  });
  assert.equal((blocks[0].segments as Array<{ text: string }>)[0].text, "No written answer is available for this question; try asking again.");
});

test("with claims unreadable and nothing else on file, the gap never says there are no claims (#207)", () => {
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    status: "ok",
    result: { evidence_status: "insufficient_evidence", evidence: { claims: [], unavailable: true } },
  } as never;
  const packet = answerContext({ context: { userIntent: "Analyze ACME", bundleId: "single_name" }, toolCalls: [toolCall] }).evidence_packet as Record<string, unknown>;
  assert.equal(packet.claims_status, "unavailable");
  assert.deepEqual(packet.gaps, ["No reported facts or quote are on file for this subject, and its research claims could not be read."]);
});

test("with rendering off, the answer's assertion list is checked in shadow and never shown (#208)", async () => {
  const reports: unknown[] = [];
  const list = JSON.stringify([
    { kind: "observation", text: "NVDA's revenue is shown.", evidence: ["F1"] },
    { kind: "observation", text: "Revenue rose.", evidence: ["F99"] },
  ]);
  const composed = await composeAnalystBlocksWithLlm({
    env: { ...BASE_ENV, CHAT_ASSERTION_RENDERING: "0" },
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: COMPARISON_BLOCKS,
    createClient: () => async () => ({ text: `NVDA is larger.\n\n\`\`\`assertions\n${list}\n\`\`\`` }),
    onAssertions: (report) => reports.push(report),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0].text, "NVDA is larger.");
  assert.deepEqual(reports, [{
    status: "checked",
    accepted: [{ index: 0, kind: "observation", text: "NVDA's revenue is shown.", evidence: ["F1"] }],
    rejected: [{ index: 1, text: "Revenue rose.", reason: 'unknown evidence id "F99"' }],
  }]);
});

test("with no figures shown there is nothing to bind, so the check is skipped (#208)", async () => {
  const reports: Array<{ status: string }> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Analyze ACME", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [],
    createClient: () => async () => ({ text: "ACME trades at $12.\n```assertions\n[{\"kind\":\"observation\",\"text\":\"ACME trades at $12.\",\"evidence\":[]}]\n```" }),
    onAssertions: (report) => reports.push(report),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0].text, "ACME trades at $12.");
  assert.deepEqual(reports.map((report) => report.status), ["skipped"]);
});

test("an answer cut off inside its assertion list keeps the prose before it (#208)", async () => {
  const reports: Array<{ status: string }> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: COMPARISON_BLOCKS,
    createClient: () => async () => ({ text: "NVDA is larger.\n\n```assertions\n[{\"kind\":\"obs", truncated: true }),
    onAssertions: (report) => reports.push(report),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0].text, "NVDA is larger.");
  assert.deepEqual(reports.map((report) => report.status), ["malformed"]);
});

test("an answer cut off in prose after a closed assertion list shows the fallback (#208)", async () => {
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: COMPARISON_BLOCKS,
    createClient: () => async () => ({ text: "NVDA is larger.\n```assertions\n[]\n```\nAMD's margin trails beca", truncated: true }),
  });
  assert.notEqual((composed[0].segments as Array<{ text: string }>)[0].text, "NVDA is larger.\n\nAMD's margin trails beca");
  assert.doesNotMatch((composed[0].segments as Array<{ text: string }>)[0].text, /beca$/);
});

const FACT = (n: number) => `f2080000-0000-4000-8000-00000000000${n}`;
const RENDER_BLOCKS = [{
  id: "comparison-1",
  kind: "metrics_comparison",
  title: "Side by side (latest fiscal year)",
  subjects: [{ kind: "issuer", id: "issuer-nvda" }, { kind: "issuer", id: "issuer-amd" }],
  subject_labels: ["NVDA", "AMD"],
  metrics: ["Revenue", "Gross Margin"],
  source_refs: ["s-nvda", "s-amd"],
  cells: [
    [{ value_ref: FACT(1), format: "$130.5B" }, { value_ref: FACT(2), format: "74.6%" }],
    [{ value_ref: FACT(3), format: "$25.8B" }, { value_ref: FACT(4), format: "49.2%" }],
  ],
  data_ref: { kind: "metrics_comparison", id: "comparison-1", params: { fact_bindings: [1, 2, 3, 4].map((n) => ({
    fact_id: FACT(n), unit: n % 2 ? "USD" : "ratio", period_kind: "fiscal_y", fiscal_year: n < 3 ? 2026 : 2025, fiscal_period: "FY",
    period_end: n < 3 ? "2026-01-25" : "2025-12-27", as_of: "2026-02-26T00:00:00.000Z", source_id: n < 3 ? "s-nvda" : "s-amd",
  })) } },
}];
const RENDERING_ENV = { ...BASE_ENV, CHAT_ASSERTION_RENDERING: "1" };

async function renderWithReply(reply: string, env: Record<string, string> = RENDERING_ENV) {
  const reports: Array<Record<string, unknown>> = [];
  const blocks = await composeAnalystBlocksWithLlm({
    env,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: RENDER_BLOCKS,
    createClient: () => async () => ({ text: reply }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
  });
  return { block: blocks[0] as Record<string, unknown>, report: reports[0]! };
}
const withList = (list: unknown[]) => `NVDA earns more on each sale than AMD.\n\n\`\`\`assertions\n${JSON.stringify(list)}\n\`\`\``;

// One company, "A", whose figures the guard never credits (a one-letter ticker
// reads as the article), and one sourced claim: the guard drops A's observation
// while the claim's attribution stands.
const A_CLAIM = "c2080000-0000-4000-8000-000000000021";
const A_BLOCKS = [{ ...RENDER_BLOCKS[0]!, subject_labels: ["A"], cells: [RENDER_BLOCKS[0]!.cells[0]!] }];
const A_TOOL_CALL = {
  tool_call_id: "tc-a",
  tool_name: "research_lookup",
  status: "ok",
  result: { evidence: { claims: [{ claim_id: A_CLAIM, source_id: "s-a", text_canonical: "Management raised its outlook.", predicate: "guidance.change", polarity: "positive", published_at: "2026-02-25T00:00:00.000Z" }] } },
} as never;
async function renderA(list: unknown[]) {
  const reports: Array<Record<string, unknown>> = [];
  const removed: string[][] = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Analyze A", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [A_TOOL_CALL],
    factBlocks: A_BLOCKS,
    createClient: () => async () => ({ text: withList(list) }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
    onNarrativeRemoved: (sentences) => removed.push([...sentences]),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  return { text, report: reports[0]!, removed };
}

test("with rendering on, the answer is written from its accepted assertions, values as sealed refs (#208)", async () => {
  const { block, report } = await renderWithReply(withList([
    { kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] },
    { kind: "observation", text: "NVDA's revenue was $99B.", evidence: ["F1"] },
    // Two companies in one period show no change.
    { kind: "unknown_cause", text: "The figures do not show why.", evidence: ["F2", "F4"] },
  ]));
  const segments = block.segments as Array<{ type: string; text?: string; format?: string; ref_id?: string }>;
  assert.equal(
    segments.map((segment) => segment.text ?? segment.format).join(""),
    "NVDA's gross margin was 74.6% in FY2026 (ended Jan 2026); AMD's gross margin was 49.2% in FY2025 (ended Dec 2025).",
  );
  assert.deepEqual(segments.filter((segment) => segment.type === "ref").map((segment) => segment.ref_id), [FACT(2), FACT(4)]);
  assert.deepEqual(
    ((block.data_ref as { params: { fact_bindings: Array<{ fact_id: string }> } }).params.fact_bindings).map((binding) => binding.fact_id),
    [FACT(2), FACT(4)],
  );
  assert.deepEqual(block.source_refs, ["s-nvda", "s-amd"]);
  assert.equal(report.rendered, true);
  assert.deepEqual((report.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [1, "$99B is not a cited figure's value"],
    [2, "an unknown cause cites a change: one company's metric, two periods, two values"],
  ]);
});

test("rendering keeps the narrative guard as its backstop, assertion by assertion (#208)", async () => {
  const { text, report } = await renderA([
    { kind: "management_attribution", text: "Management raised its outlook.", evidence: ["C1"] },
    { kind: "observation", text: "A's gross margin was 74.6%.", evidence: ["F2"] },
  ]);
  assert.equal(text, "According to a source dated Feb 2026: Management raised its outlook.");
  assert.equal(report.rendered, true);
  assert.deepEqual(report.rejected, [{ index: 1, text: "A's gross margin was 74.6% in FY2026 (ended Jan 2026).", reason: "removed by the narrative guard" }]);
});

test("with rendering off, or nothing accepted, the guarded prose stands (#208)", async () => {
  // Both companies' figures, so only the flag keeps the prose.
  const both = [{ kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] }];
  const off = await renderWithReply(withList(both), { ...BASE_ENV, CHAT_ASSERTION_RENDERING: "0" });
  assert.equal((off.block.segments as Array<{ text: string }>)[0]!.text, "NVDA earns more on each sale than AMD.");
  assert.equal(off.report.rendered, undefined);
  // Unset is off.
  assert.equal((await renderWithReply(withList(both), BASE_ENV)).report.rendered, undefined);
  const none = await renderWithReply(withList([{ kind: "observation", text: "NVDA's gross margin was 99%.", evidence: ["F2"] }]));
  assert.equal((none.block.segments as Array<{ text: string }>)[0]!.text, "NVDA earns more on each sale than AMD.");
  assert.equal(none.report.rendered, undefined);
});

test("a claim-only answer is rendered too; guard drops while rendering count as narrative removals (#208)", async () => {
  const claimId = "c2080000-0000-4000-8000-000000000001";
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    status: "ok",
    result: { evidence: { claims: [{ claim_id: claimId, source_id: "s-claim", text_canonical: "Management raised its outlook.", predicate: "guidance.change", polarity: "positive", effective_time: "2026-02-25T00:00:00.000Z" }] } },
  } as never;
  const reports: Array<Record<string, unknown>> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "What did management say?", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [toolCall],
    factBlocks: [],
    createClient: () => async () => ({ text: withList([{ kind: "management_attribution", text: "Management raised its outlook.", evidence: ["C1"] }]) }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
  });
  const segments = composed[0].segments as Array<{ type: string; ref_id?: string; text?: string; format?: string }>;
  assert.equal(segments.map((segment) => segment.text ?? segment.format).join(""), "According to a source, effective Feb 2026: Management raised its outlook.");
  assert.equal(segments.at(-1)?.ref_id, claimId);
  assert.equal(reports[0]?.rendered, true);

  const { removed } = await renderA([
    { kind: "management_attribution", text: "Management raised its outlook.", evidence: ["C1"] },
    { kind: "observation", text: "A's gross margin was 74.6%.", evidence: ["F2"] },
  ]);
  assert.deepEqual(removed, [["A's gross margin was 74.6% in FY2026 (ended Jan 2026)."]]);
});

test("a rendered answer keeps a stale-data warning; a sourced causal claim renders with no figures shown (#208)", async () => {
  const stale = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    status: "ok",
    result: { structured_context: {
      quote: { ticker: "NVDA", as_of: "2026-06-01T00:00:00.000Z", stale: true },
      fact_recency: { latest_as_of: "2026-02-26T00:00:00.000Z", fiscal_year: 2026, fiscal_period: "FY", age_days: 190, stale: true },
    } },
  } as never;
  const staleAnswer = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [stale],
    factBlocks: RENDER_BLOCKS,
    createClient: () => async () => ({ text: withList([{ kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] }]) }),
  });
  const staleText = (staleAnswer[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.equal(staleText, "NVDA's gross margin was 74.6% in FY2026 (ended Jan 2026); AMD's gross margin was 49.2% in FY2025 (ended Dec 2025).\n\nThe latest reported figures are 190 days old and may be out of date. The quote, as of Jun 2026, may be out of date.");

  const claimId = "c2080000-0000-4000-8000-000000000002";
  const causal = {
    tool_call_id: "tc-2",
    tool_name: "research_lookup",
    status: "ok",
    result: { evidence: { claims: [{ claim_id: claimId, source_id: "s", text_canonical: "Margins rose due to a richer mix.", predicate: "kpi.commentary", polarity: "positive", published_at: "2026-02-25T00:00:00.000Z" }] } },
  } as never;
  const claimAnswer = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Why did margins rise?", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [causal],
    factBlocks: [],
    createClient: () => async () => ({ text: withList([{ kind: "management_attribution", text: "Margins rose due to a richer mix.", evidence: ["C1"] }]) }),
  });
  const claimText = (claimAnswer[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.equal(claimText, "According to a source dated Feb 2026: Margins rose due to a richer mix.");
});

test("an inference resting on an observation the guard removed is removed too (#208)", async () => {
  const { text, report } = await renderA([
    { kind: "observation", text: "A's gross margin was 74.6%.", evidence: ["F2"] },
    { kind: "management_attribution", text: "Management raised its outlook.", evidence: ["C1"] },
    { kind: "analyst_inference", text: "A appears well run.", evidence: [], supports: [0] },
  ]);
  assert.equal(text, "According to a source dated Feb 2026: Management raised its outlook.");
  assert.deepEqual((report.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [0, "removed by the narrative guard"],
    [2, "rests on an observation the narrative guard removed"],
  ]);
});

test("a rendered inference's figures are its supports' fact refs; one it cannot link is not rendered (#208)", async () => {
  const { block, report } = await renderWithReply(withList([
    { kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] },
    { kind: "analyst_inference", text: "NVDA's 74.6% margin outruns AMD's 49.2%.", evidence: [], supports: [0] },
    { kind: "analyst_inference", text: "NVDA appears to hold pricing power.", evidence: [], supports: [0] },
    // 74.6% is NVDA's figure, so it cannot be AMD's: the binding check rejects it.
    { kind: "analyst_inference", text: "AMD's 74.6% margin stands out.", evidence: [], supports: [0] },
  ]));
  const segments = block.segments as Array<{ type: string; text?: string; format?: string; ref_id?: string }>;
  const text = segments.map((segment) => segment.text ?? segment.format).join("");
  assert.match(text, /> \*\*Analyst inference:\*\* NVDA's 74\.6% margin outruns AMD's 49\.2%\./);
  assert.match(text, /> \*\*Analyst inference:\*\* NVDA appears to hold pricing power\.$/);
  // The observation's two refs, then the inference's, all sealed facts.
  assert.deepEqual(segments.filter((segment) => segment.type === "ref").map((segment) => segment.ref_id), [FACT(2), FACT(4), FACT(2), FACT(4)]);
  assert.deepEqual((report.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [3, "74.6% is not a cited figure's value for AMD"],
  ]);
});

test("a rendered answer says which compared companies it shows no figures for (#208)", async () => {
  const nvdaOnly = [{ ...RENDER_BLOCKS[0]!, cells: [RENDER_BLOCKS[0]!.cells[0]!, [null, null]] }];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: nvdaOnly,
    createClient: () => async () => ({ text: withList([{ kind: "observation", text: "NVDA's gross margin was 74.6%.", evidence: ["F2"] }]) }),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.equal(text, "NVDA's gross margin was 74.6% in FY2026 (ended Jan 2026).\n\nNo figures are shown for AMD.");
});

test("a rendered answer keeps the other side of a stored disagreement (#208)", async () => {
  const claim = (n: number, text: string, polarity: string) => ({
    claim_id: `c2080000-0000-4000-8000-00000000001${n}`, source_id: `s${n}`, text_canonical: text, predicate: "kpi.commentary", polarity, published_at: "2026-02-25T00:00:00.000Z",
  });
  const toolCall = {
    tool_call_id: "tc-1",
    tool_name: "research_lookup",
    status: "ok",
    result: { evidence: {
      claims: [claim(1, "Backlog grew.", "positive"), claim(2, "Backlog shrank.", "negative")],
      contradictions: [["c2080000-0000-4000-8000-000000000011", "c2080000-0000-4000-8000-000000000012"]],
    } },
  } as never;
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "What happened to backlog?", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [toolCall],
    factBlocks: [],
    createClient: () => async () => ({ text: withList([{ kind: "management_attribution", text: "Backlog grew.", evidence: ["C1"] }]) }),
  });
  const segments = composed[0].segments as Array<{ type: string; text?: string; format?: string; ref_id?: string }>;
  assert.equal(
    segments.map((segment) => segment.text ?? segment.format).join(""),
    "According to a source dated Feb 2026: Backlog grew.\n\nA source disagrees. According to a source dated Feb 2026: Backlog shrank.",
  );
  assert.deepEqual(segments.filter((segment) => segment.type === "ref").map((segment) => segment.ref_id), [
    "c2080000-0000-4000-8000-000000000011", "c2080000-0000-4000-8000-000000000012",
  ]);
});

test("a rendered comparison covers every company it shows figures for, and warns of calendars across observations (#208)", async () => {
  const oneSided = await renderWithReply(withList([{ kind: "observation", text: "NVDA's gross margin was 74.6%.", evidence: ["F2"] }]));
  assert.equal((oneSided.block.segments as Array<{ text: string }>)[0]!.text, "NVDA earns more on each sale than AMD.");
  assert.equal(oneSided.report.rendered, undefined);

  const sameYear = [{
    ...RENDER_BLOCKS[0]!,
    data_ref: { ...RENDER_BLOCKS[0]!.data_ref, params: { fact_bindings: RENDER_BLOCKS[0]!.data_ref.params.fact_bindings.map((binding) => ({ ...binding, fiscal_year: 2026 })) } },
  }];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: sameYear,
    createClient: () => async () => ({ text: withList([
      { kind: "observation", text: "NVDA's gross margin was 74.6%.", evidence: ["F2"] },
      { kind: "observation", text: "AMD's gross margin was 49.2%.", evidence: ["F4"] },
    ]) }),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.match(text, /\n\nThe same fiscal year ends in different months for each company, so the periods do not line up\.$/);
});

test("a rendered answer says when more claims matched, or none could be read (#208)", async () => {
  const truncated = { ...(A_TOOL_CALL as unknown as Record<string, unknown>) };
  truncated.result = { evidence: { ...((A_TOOL_CALL as unknown as { result: { evidence: Record<string, unknown> } }).result.evidence), truncated: true } };
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Analyze A", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [truncated as never],
    factBlocks: A_BLOCKS,
    createClient: () => async () => ({ text: withList([{ kind: "management_attribution", text: "Management raised its outlook.", evidence: ["C1"] }]) }),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.equal(text, "According to a source dated Feb 2026: Management raised its outlook.\n\nMore sources matched than are shown here.");

  const unreadable = { tool_call_id: "tc-u", tool_name: "research_lookup", status: "ok", result: { evidence: { claims: [], unavailable: true } } } as never;
  const answer = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Compare NVDA with AMD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [unreadable],
    factBlocks: RENDER_BLOCKS,
    createClient: () => async () => ({ text: withList([{ kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] }]) }),
  });
  assert.match((answer[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join(""), /\n\nResearch claims could not be read for this answer\.$/);
});

test("an observation whose value cannot be sealed is not rendered (#208)", async () => {
  // A price return is read off its chart series, with no fact behind it.
  const perf = [{ id: "perf-1", kind: "perf_comparison", title: "Price performance", default_range: "YTD 2026: 2025-12-31 close to 2026-08-31 close",
    series: [{ name: "NVDA", points: [{ x: "2025-12-31", y: 0 }, { x: "2026-08-31", y: 12.5 }] }] }];
  const reports: Array<Record<string, unknown>> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "How has NVDA done YTD?", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: perf,
    createClient: () => async () => ({ text: `NVDA returned 12.5% this year.\n\n\`\`\`assertions\n${JSON.stringify([{ kind: "observation", text: "NVDA returned 12.5%.", evidence: ["F1"] }])}\n\`\`\`` }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
  });
  assert.equal((composed[0].segments as Array<{ text: string }>)[0]!.text, "NVDA returned 12.5% this year.");
  assert.equal(reports[0]!.rendered, undefined);
  assert.deepEqual(
    (reports[0]!.rejected as Array<{ reason: string }>).map((entry) => entry.reason),
    ["its figure has no fact to seal, so it is not rendered"],
  );
});

test("a comparison renders its checked result through the guard; an inference's ranking does not render (#208)", async () => {
  const { block, report } = await renderWithReply(withList([
    { kind: "comparison", op: "highest", result: "F2", text: "NVDA's gross margin is the highest.", evidence: ["F2", "F4"] },
    { kind: "analyst_inference", text: "NVDA keeps more of each sale than AMD.", evidence: [], supports: [0] },
    { kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] },
    { kind: "analyst_inference", text: "AMD trails NVDA on profitability.", evidence: [], supports: [2] },
  ]));
  const segments = block.segments as Array<{ type: string; text?: string; format?: string; ref_id?: string }>;
  assert.equal(
    segments.map((segment) => segment.text ?? segment.format).join(""),
    "Of NVDA and AMD, NVDA's gross margin was highest: NVDA 74.6% (FY2026, ended Jan 2026), AMD 49.2% (FY2025, ended Dec 2025)." +
      "\n\nNVDA's gross margin was 74.6% in FY2026 (ended Jan 2026); AMD's gross margin was 49.2% in FY2025 (ended Dec 2025).",
  );
  assert.deepEqual(segments.filter((segment) => segment.type === "ref").map((segment) => segment.ref_id), [FACT(2), FACT(4), FACT(2), FACT(4)]);
  // Resting on the checked comparison or not, an inference's ranking is its own wording.
  assert.deepEqual((report.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [1, "a rendered inference states no ranking or direction; its comparisons do"],
    [3, "a rendered inference states no ranking or direction; its comparisons do"],
  ]);

  // The wrong winner, every number right: rejected, and the inference with it.
  const wrong = await renderWithReply(withList([
    { kind: "comparison", op: "highest", result: "F4", text: "AMD's gross margin is the highest.", evidence: ["F2", "F4"] },
    { kind: "analyst_inference", text: "AMD keeps more of each sale than NVDA.", evidence: [], supports: [0] },
  ]));
  assert.deepEqual((wrong.report.rejected as Array<{ index: number; reason: string }>).map((entry) => entry.reason), [
    "comparison: F2 (74.6%) is higher than F4 (49.2%)",
    "an inference binds the accepted observations it rests on",
  ]);
  assert.equal(wrong.report.rendered, undefined);
});

test("a single company's checked trend and low render through the guard (#208)", async () => {
  const quarters = [["Q1 2025", "2025-03-29", "10.8%", 2025, "Q1"], ["Q2 2025", "2025-06-28", "-1.7%", 2025, "Q2"], ["Q3 2025", "2025-09-27", "13.7%", 2025, "Q3"], ["Q4 2025", "2025-12-27", "14.1%", 2025, "Q4"]] as const;
  const id = (n: number) => `d2080000-0000-4000-8000-00000000000${n}`;
  const trendRow = {
    id: "margin-trend", kind: "metric_row", title: "Operating margin by quarter", subjects: [{ kind: "issuer", id: "i-amd" }], subject_labels: ["AMD"],
    items: quarters.map(([label, , format], n) => ({ label, format, value_ref: id(n) })),
    source_refs: ["s-amd"],
    data_ref: { kind: "metric_row", id: "margin-trend", params: { fact_bindings: quarters.map(([, period_end, , fiscal_year, fiscal_period], n) => ({
      fact_id: id(n), unit: "ratio", period_kind: "fiscal_q", fiscal_year, fiscal_period, period_end, as_of: "2026-02-26T00:00:00.000Z",
    })) } },
  };
  const reports: Array<Record<string, unknown>> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "How have AMD's operating margins trended?", bundleId: "single_name" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [trendRow],
    subjectLabels: ["AMD"],
    createClient: () => async () => ({ text: withList([
      { kind: "comparison", op: "trend", result: "rebounded", text: "AMD's operating margin rebounded.", evidence: ["F1", "F2", "F3", "F4"] },
      { kind: "comparison", op: "lowest", result: "F2", text: "Q2 2025 was the low.", evidence: ["F1", "F2", "F3", "F4"] },
      // The convenient endpoint: rejected.
      { kind: "comparison", op: "lowest", result: "F1", text: "Q1 2025 was the low.", evidence: ["F1", "F3", "F4"] },
    ]) }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.equal(text,
    "AMD's operating margin fell from 10.8% in Q1 2025 to a low of -1.7% in Q2 2025, then rebounded to 14.1% in Q4 2025, above where it started." +
    "\n\nAMD's operating margin was lowest in Q2 2025, at -1.7%, of the periods from Q1 2025 to Q4 2025.");
  assert.deepEqual((reports[0]!.rejected as Array<{ reason: string }>).map((entry) => entry.reason), [
    "comparison: leaves out Q2 2025, which shows operating margin too",
  ]);
});

test("an inference states no ranking or direction of its own, even resting on a checked comparison (#208 review)", async () => {
  const { block, report } = await renderWithReply(withList([
    { kind: "comparison", op: "highest", result: "F2", text: "NVDA's gross margin is the highest.", evidence: ["F2", "F4"] },
    // Contradicts its comparison: NVDA is highest.
    { kind: "analyst_inference", text: "AMD leads NVDA on profitability.", evidence: [], supports: [0] },
    { kind: "analyst_inference", text: "NVDA appears to hold pricing power.", evidence: [], supports: [0] },
  ]));
  const text = (block.segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.doesNotMatch(text, /AMD leads/);
  assert.match(text, /NVDA appears to hold pricing power/);
  assert.deepEqual((report.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [1, "a rendered inference states no ranking or direction; its comparisons do"],
  ]);
});

test("an inference whose support was left out of the answer is left out too (#208 review)", async () => {
  // A price return read off its chart has no fact to seal.
  const perf = { id: "perf-1", kind: "perf_comparison", title: "Price performance", default_range: "YTD 2026", series: [
    { name: "NVDA", points: [{ y: 0 }, { y: 5.81 }] }, { name: "AMD", points: [{ y: 0 }, { y: 3.17 }] },
  ] };
  const reports: Array<Record<string, unknown>> = [];
  const composed = await composeAnalystBlocksWithLlm({
    env: RENDERING_ENV,
    context: { userIntent: "Compare NVDA with AMD YTD", bundleId: "peer_comparison" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [...RENDER_BLOCKS, perf],
    createClient: () => async () => ({ text: withList([
      { kind: "observation", text: "NVDA's gross margin was 74.6% and AMD's was 49.2%.", evidence: ["F2", "F4"] },
      { kind: "observation", text: "NVDA's price return was 5.81% and AMD's 3.17%.", evidence: ["F5", "F6"] },
      { kind: "analyst_inference", text: "Momentum remains with NVDA.", evidence: [], supports: [1] },
      { kind: "analyst_inference", text: "NVDA appears to hold pricing power.", evidence: [], supports: [0] },
    ]) }),
    onAssertions: (report) => reports.push(report as unknown as Record<string, unknown>),
  });
  const text = (composed[0].segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.doesNotMatch(text, /Momentum/);
  assert.match(text, /NVDA appears to hold pricing power/);
  assert.deepEqual((reports[0]!.rejected as Array<{ index: number; reason: string }>).map((entry) => [entry.index, entry.reason]), [
    [1, "its figure has no fact to seal, so it is not rendered"],
    [2, "rests on an assertion left out of the answer"],
  ]);
});

test("with rendering on, a rejected comparison never falls back to the model's prose (#286 review)", async () => {
  // The prose names the wrong winner; its comparison is rejected, nothing else is listed.
  const reply = "AMD has the highest gross margin.\n\n```assertions\n" + JSON.stringify([
    { kind: "comparison", op: "highest", result: "F4", text: "AMD's gross margin is the highest.", evidence: ["F2", "F4"] },
  ]) + "\n```";
  const { block, report } = await renderWithReply(reply);
  const text = (block.segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.doesNotMatch(text, /AMD has the highest/);
  assert.equal(report.rendered, undefined);
  // With rendering off the guarded prose stands, as before.
  const off = await renderWithReply(reply, { ...BASE_ENV, CHAT_ASSERTION_RENDERING: "0" });
  assert.match((off.block.segments as Array<{ text: string }>)[0]!.text, /AMD has the highest/);
});

test("with rendering on, a comparison rejected for its shape also keeps the prose out (#286 review)", async () => {
  // One figure: rejected by the shape check, before the comparison check.
  const reply = "AMD has the highest gross margin.\n\n```assertions\n" + JSON.stringify([
    { kind: "comparison", op: "highest", result: "F4", text: "AMD's gross margin is the highest.", evidence: ["F4"] },
  ]) + "\n```";
  const { block, report } = await renderWithReply(reply);
  assert.deepEqual((report.rejected as Array<{ reason: string }>).map((entry) => entry.reason), ["a comparison cites two or more figures, and only figures"]);
  const text = (block.segments as Array<{ text?: string; format?: string }>).map((segment) => segment.text ?? segment.format).join("");
  assert.doesNotMatch(text, /AMD has the highest/);
});

test("on a named-gap turn the model sees no data, so a number in its prose is never shown (#221)", async () => {
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "What is AMD's free cash flow?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [],
    factBlocks: [],
    availableData: false,
    createClient: () => async () => ({ text: "Free cash flow is not available for AMD in this data. AMD's free cash flow was $3.1B in fiscal 2025." }),
  });
  const text = (composed[0].segments as Array<{ text: string }>).map((segment) => segment.text).join("");
  assert.match(text, /Free cash flow is not available for AMD in this data\./);
  assert.doesNotMatch(text, /\$3\.1B/);
});

test("on a named-gap turn a claim's number is no support for another metric (#294 review)", async () => {
  const claim = {
    tool_call_id: "tc-claim",
    tool_name: "research_lookup",
    status: "ok",
    result: { evidence: { claims: [{ claim_id: "c2210000-0000-4000-8000-000000000001", source_id: "s", text_canonical: "The restrictions led to approximately $800 million in inventory and related charges.", predicate: "kpi.commentary", polarity: "negative", published_at: "2025-08-05T00:00:00.000Z" }] } },
  } as never;
  const composed = await composeAnalystBlocksWithLlm({
    env: BASE_ENV,
    context: { userIntent: "What is AMD's free cash flow?", bundleId: "single_subject_analysis" },
    blocks: [NARRATIVE_BLOCK],
    toolCalls: [claim],
    factBlocks: [],
    availableData: false,
    createClient: () => async () => ({ text: "Free cash flow is not available for AMD in this data. AMD's free cash flow was approximately $800 million." }),
  });
  const text = (composed[0].segments as Array<{ text: string }>).map((segment) => segment.text).join("");
  assert.match(text, /Free cash flow is not available for AMD in this data\./);
  assert.doesNotMatch(text, /\$800 million/);
});
