import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { replayRecorded } from "../src/answer-trace.ts";
import { answerText, assertionSummary, judgeSummary, mutationSummary, mutationVariants, readTraces, replyFixture } from "../scripts/answer-lab.ts";
import { createReplayLlmChatClient } from "../../llm/src/replay-client.ts";

// One live research-quality eval run's turns (scripts/research-quality-eval.ts).
const TRACES = readTraces([fileURLToPath(new URL("./answer-lab/traces/", import.meta.url))]);

test("the recorded traces cover the eval", () => {
  assert.equal(TRACES.length, 14);
});

for (const { label, trace } of TRACES) {
  test(`${label}: the recorded reply replays to the recorded blocks`, async () => {
    const replayed = await replayRecorded(trace);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(replayed.blocks)), trace.blocks);
  });
}

// Writes each trace as its file under a fresh directory; returns that directory.
function traceFiles(files: Record<string, object>): string {
  const root = mkdtempSync(join(tmpdir(), "answer-lab-"));
  for (const [file, trace] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(trace));
  }
  return root;
}

test("traces are keyed by the turn they record, whatever their file names", () => {
  const [first] = TRACES;
  const turn = (run_id: string) => ({ ...first!.trace, run_id, turn_id: undefined });
  const root = traceFiles({ "a/run.json": turn("run-a"), "b/run.json": turn("run-b"), "run": turn("run-c") });
  const keyed = readTraces(["a/run.json", "b/run.json", "run"].map((file) => join(root, file)));
  assert.deepEqual(keyed.map(({ key, label }) => [key, label]), [
    [`${first!.trace.thread_id}/run-a`, "run"],
    [`${first!.trace.thread_id}/run-b`, "run"],
    [`${first!.trace.thread_id}/run-c`, "run"],
  ]);
});

test("the keys do not depend on the order traces are given in", () => {
  const [first, second, third] = TRACES;
  const root = traceFiles({ "fixtures/x.json": first!.trace, "y.json": second!.trace, "z.json": third!.trace });
  const inputs = ["fixtures", "y.json", "z.json"].map((path) => join(root, path));
  const keys = (paths: string[]) => readTraces(paths).map(({ key }) => key).sort();
  assert.deepEqual(keys([inputs[2]!, inputs[0]!, inputs[1]!]), keys(inputs));
});

test("one turn given twice is an error, not a guess", () => {
  const [first] = TRACES;
  const root = traceFiles({ "fixtures/run.json": first!.trace });
  assert.throws(() => readTraces([join(root, "fixtures"), join(root, "fixtures/run.json")]), /is given twice/);
});

test("a file without a turn's ids is refused, by name", () => {
  const [first] = TRACES;
  const root = traceFiles({ "handmade.json": { ...first!.trace, thread_id: undefined } });
  assert.throws(() => readTraces([join(root, "handmade.json")]), /handmade\.json is not a turn trace/);
});

test("a live sample's answer reads as the user sees it: text as written, each ref its displayed value", () => {
  const blocks = [
    { kind: "metric_row", items: [] },
    { kind: "rich_text", segments: [{ type: "text", text: "NVDA's revenue was " }, { type: "ref", ref_kind: "fact", ref_id: "f1", format: "$62.1B" }, { type: "text", text: "." }] },
    { kind: "rich_text", segments: [{ type: "text", text: "Second block." }] },
  ];
  assert.equal(answerText(blocks), "NVDA's revenue was $62.1B.\n\nSecond block.");
});

test("a live run's summary counts rendered answers, accepted kinds, repeated observations and rejections by reason", () => {
  const metrics = { figure_refs: 0, plain_numbers: 0, removed: 0, fallback: false, accepted: 0, rejected: 0, output_tokens: 0, latency_ms: 0 };
  const summary = assertionSummary({
    results: [
      { trace: "a", sample: 0, metrics, assertions: { rendered: true, accepted: ["observation", "analyst_inference", "observation"], rejected: ["x", "y"], repeated: 2 } },
      { trace: "b", sample: 0, metrics, assertions: { rendered: false, accepted: ["comparison"], rejected: ["y"] } },
      { trace: "c", sample: 0, error: "timeout" },
    ],
  });
  assert.equal(summary, [
    "rendered: 1 of 2 answers",
    "accepted: 2 observation, 1 analyst_inference, 1 comparison",
    "repeated: 2 observations a comparison already shows",
    "rejected:",
    "    2  y",
    "    1  x",
  ].join("\n"));
});

test("the traces' reply fixture answers each traced question as recorded, and a title as the golden test does (DEV_NO_KEYS=traces)", async () => {
  const traces = readTraces([fileURLToPath(new URL("./answer-lab/traces", import.meta.url))]);
  const golden = { replies: [{ match: "Create a short, specific research chat title", text: "NVDA research" }, { match: "Write a concise", text: "golden" }] };
  const dir = mkdtempSync(join(tmpdir(), "replies-"));
  const file = join(dir, "replies.json");
  writeFileSync(file, JSON.stringify(replyFixture(traces, golden)));
  const reply = await createReplayLlmChatClient(file);
  const ask = async (content: string) => (await reply({} as never, { messages: [{ role: "user", content }] } as never)).text;
  // Each trace's own recorded request gets its own reply.
  for (const { label, trace } of traces) {
    assert.equal(await ask(trace.exchange!.messages.map((message) => message.content).join("\n")), trace.exchange!.text, label);
  }
  // A short question asked after a longer one in its thread: the history quotes the longer one.
  const recorded = (question: string) => traces.find(({ trace }) => trace.question === question)!.trace.exchange!.text;
  assert.equal(await ask(JSON.stringify({ conversation: ["Analyze NVDA's latest quarter."], question: "Analyze NVDA." })), recorded("Analyze NVDA."));
  assert.equal(await ask("Create a short, specific research chat title for: Compare NVDA with AMD."), "NVDA research");
});

const MUTATIONS = fileURLToPath(new URL("./answer-lab/judge-mutations.json", import.meta.url));

test("the judge's held-out set: every original and mutation passes the turn's own checks, so each is a gap only the judge can catch (#302)", () => {
  const variants = mutationVariants(MUTATIONS);
  const count = (key: (variant: (typeof variants)[number]) => string) =>
    Object.fromEntries([...new Set(variants.map(key))].map((value) => [value, variants.filter((variant) => key(variant) === value).length]));
  assert.deepEqual(count((variant) => variant.kind), {
    original: 7,
    worded_amount: 5,
    unsupported_claim: 5,
    contradicted_ranking: 3,
    company_name: 4,
    flipped_direction: 3,
  });
  // The judge reads a case on its trace's packet: the peer case's label is its comparisons' checked results.
  const peer = variants.find((variant) => variant.id === "peer-lead" && variant.kind === "original")!;
  assert.deepEqual([peer.judged.subject, peer.judged.checked, peer.companies], ["NVDA", ["NVDA highest on revenue, gross margin, net margin, and revenue growth (YoY)"], ["NVDA", "AMD"]]);
});

test("a set inference the word rules already reject fails the set, rather than inflate the catch rate", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-mutations-"));
  const file = join(dir, "set.json");
  writeFileSync(file, JSON.stringify({ cases: [{
    id: "typed",
    trace: fileURLToPath(new URL("./answer-lab/traces/segment-drill-down.json", import.meta.url)),
    index: 6,
    supports: [5],
    original: "Data Center dominates the top line.",
    mutations: [{ kind: "worded_amount", text: "Data Center brings in ninety percent of the top line." }],
  }] }));
  assert.throws(() => mutationVariants(file), {
    message: "typed worded_amount: the turn's checks reject it (an inference rests on its supports; it writes no figure); the set holds only inferences they pass",
  });
});

test("the mutation summary counts catches by kind and false alarms on originals; an error is neither", () => {
  const result = (id: string, kind: string, verdict: string, reason?: string) =>
    ({ id, kind, text: `${id} ${kind}`, verdict: { index: 0, verdict, ...(reason ? { reason } : {}) } }) as Parameters<typeof mutationSummary>[0][number];
  assert.equal(mutationSummary([
    result("a", "original", "entailed"),
    result("a", "worded_amount", "not_entailed", "worded_amount: says tens of billions"),
    result("a", "company_name", "entailed"),
    result("b", "original", "not_entailed", "unsupported: no figure shows it"),
    result("b", "flipped_direction", "error", "judge call failed: timeout"),
  ]), [
    "caught: 1 of 3 mutations (1 errors)",
    "  worded_amount          1 of 1",
    "  company_name           0 of 1",
    "  unsupported_claim      0 of 0",
    "  flipped_direction      0 of 1",
    "  contradicted_ranking   0 of 0",
    "false alarms: 1 of 2 originals (0 errors)",
    "misses, false alarms and errors:",
    "  a company_name: entailed\n      a company_name",
    "  b original: not_entailed (unsupported: no figure shows it)\n      b original",
    "  b flipped_direction: error (judge call failed: timeout)\n      b flipped_direction",
  ].join("\n"));
});

test("a judged run's summary counts verdicts, the judge's cost per answer, and lists each inference it did not find entailed", () => {
  const judge = (verdicts: Array<{ index: number; verdict: "entailed" | "not_entailed" | "error"; reason?: string; text: string }>) =>
    ({ verdicts, deployment: "anthropic/claude-haiku-5-5", latency_ms: 2000, usage: { input_tokens: 1000, output_tokens: 100 } }) as never;
  const summary = judgeSummary({
    labels: { a: "peer-two" },
    results: [
      { trace: "a", sample: 1, judge: judge([{ index: 9, verdict: "entailed", text: "It leads." }, { index: 10, verdict: "not_entailed", reason: "other_company: names AMD.", text: "amd trails." }]) },
      { trace: "a", sample: 2, judge: { verdicts: [], deployment: null, latency_ms: 0 } },
      { trace: "b", sample: 0, error: "timeout" },
    ],
  });
  assert.equal(summary, [
    "judge: 1 entailed, 1 not entailed, 0 errors, of 2 inferences in 1 answers",
    "judge per answer: 2000 ms, 1000 in / 100 out tokens, on anthropic/claude-haiku-5-5",
    "  not entailed  peer-two #1 [10] amd trails.\n      other_company: names AMD.",
  ].join("\n"));
});
