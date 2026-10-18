// Answer lab: re-runs recorded answer turns (services/chat/src/answer-trace.ts)
// through today's post-processing, with the recorded model reply (recorded) or
// fresh replies from the live model (live), and tabulates what the answer shows.
//
//   node --experimental-strip-types scripts/answer-lab.ts recorded <trace dir|files...> [--check | --update] [--judge]
//   node --experimental-strip-types scripts/answer-lab.ts live <trace dir|files...> [--samples K] [--concurrency N] [--rendering on|off|recorded] [--against <run.json>] [--judge]
//   node --experimental-strip-types scripts/answer-lab.ts replies <trace dir|files...> --out <file>
//   node --experimental-strip-types scripts/answer-lab.ts judge-mutations <set.json> [--concurrency N]
//
// replies writes the traces' model replies as an LLM_REPLAY_FILE fixture, so the
// no-keys stack (DEV_NO_KEYS=traces) answers each traced question as recorded;
// recorded is deterministic and offline; --check exits 1 when a replay's blocks
// differ from the recorded ones; --update writes each replay over its trace
// (blocks, removals, assertions), for a deliberate change to post-processing. live uses the stack's LLM settings
// (LLM_SETTINGS_ENV_FILE, default .env.dev, as dev-shell sets it) and writes
// docs/eval-runs/answer-lab/<stamp>.json; --rendering sets
// CHAT_ASSERTION_RENDERING for every trace (recorded, the default: each
// trace's own), so one command shows the answers rendered or as prose.
// --judge has the judge model (JUDGE_LITELLM_MODEL, src/inference-judge.ts)
// read each answer's accepted inferences against what they rest on, and adds
// its verdicts to the table and the run. recorded also summarizes the verdicts
// the shadow judge recorded on the traces' turns, when any did. judge-mutations
// judges a held-out set of inferences and their mutations
// (test/answer-lab/judge-mutations.json) and reports how many mutations it
// catches and how many originals it flags.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { LlmRouterError } from "../../llm/src/index.ts";
import type { LlmReplayFixture } from "../../llm/src/replay-client.ts";
import { checkAssertions, splitAssertions, type AssertionKind } from "../src/assertions.ts";
import {
  answerMetrics,
  composeTraced,
  judgeAnswer,
  renderingEnv,
  replayRecorded,
  type AnswerMetrics,
  type JudgedAnswer,
  type TurnTrace,
} from "../src/answer-trace.ts";
import { judgeCases, judgeInferences, type InferenceVerdict, type JudgeCase, type JudgeOutcome } from "../src/inference-judge.ts";
import { turnPacket } from "../src/llm-runtime.ts";
import { referenceTable } from "../src/prose-refs.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNS_DIR = join(ROOT, "docs/eval-runs/answer-lab");

// key: the turn the trace records, which rows and comparisons match on;
// label: its file name, shown only.
export type LabeledTrace = { key: string; label: string; file: string; trace: TurnTrace };

export function traceKey(trace: Pick<TurnTrace, "thread_id" | "run_id" | "turn_id">): string {
  return `${trace.thread_id}/${trace.run_id}${trace.turn_id ? `.${trace.turn_id}` : ""}`;
}

// Every *.json under each path (a trace or a directory of them). One turn
// given twice is an error rather than a guess at which to keep.
export function readTraces(paths: ReadonlyArray<string>): LabeledTrace[] {
  const files = paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json")).sort().map((name) => join(path, name))
      : [path]
  );
  const seen = new Map<string, string>();
  return files.map((file) => {
    const trace = JSON.parse(readFileSync(file, "utf8")) as TurnTrace;
    const id = (value: unknown) => typeof value === "string" && /^[\w-]+$/.test(value);
    if (!id(trace.thread_id) || !id(trace.run_id) || (trace.turn_id !== undefined && !id(trace.turn_id))) {
      throw new Error(`${file} is not a turn trace: it needs thread_id and run_id (services/chat/src/answer-trace.ts)`);
    }
    const key = traceKey(trace);
    const earlier = seen.get(key);
    if (earlier !== undefined) throw new Error(`turn ${key} is given twice: ${earlier} and ${file}`);
    seen.set(key, file);
    return { key, label: basename(file, ".json"), file, trace };
  });
}

// An answer's metrics, with the judge's verdict counts when it was judged.
type JudgeCounts = { entailed: number; not_entailed: number; judge_error: number };
type SampleMetrics = AnswerMetrics & Partial<JudgeCounts>;
type Column = keyof AnswerMetrics | keyof JudgeCounts;
type Row = { key: string; label: string } & { [K in Column]?: number };
const COLUMNS: ReadonlyArray<[Column, string]> = [
  ["figure_refs", "refs"],
  ["plain_numbers", "plain#"],
  ["removed", "removed"],
  ["fallback", "fallback"],
  ["accepted", "accepted"],
  ["rejected", "rejected"],
  ["output_tokens", "out tok"],
  ["latency_ms", "latency ms"],
];
const JUDGE_COLUMNS: ReadonlyArray<[Column, string]> = [
  ["entailed", "entailed"],
  ["not_entailed", "not ent"],
  ["judge_error", "judge err"],
];
const columnsOf = (judged: boolean) => (judged ? [...COLUMNS, ...JUDGE_COLUMNS] : COLUMNS);

// A trace's row: the mean of its samples.
function meanRow(trace: { key: string; label: string }, samples: ReadonlyArray<SampleMetrics>, columns = COLUMNS): Row {
  const mean = (key: Column) =>
    samples.length === 0 ? 0 : samples.reduce((sum, metrics) => sum + Number(metrics[key] ?? 0), 0) / samples.length;
  return Object.fromEntries([["key", trace.key], ["label", trace.label], ...columns.map(([key]) => [key, mean(key)])]) as Row;
}

// Counts add up across traces; tokens and latency are per answer.
function totalRow(rows: ReadonlyArray<Row>, columns = COLUMNS): Row {
  const total = Object.fromEntries([["key", ""], ["label", "total"], ...columns.map(([key]) => [key, rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)])]) as Row;
  if (rows.length > 0) {
    total.output_tokens = (total.output_tokens ?? 0) / rows.length;
    total.latency_ms = (total.latency_ms ?? 0) / rows.length;
  }
  return total;
}

const format = (n: number | undefined) => (n === undefined ? "" : Number.isInteger(n) ? String(n) : n.toFixed(1));

function table(rows: ReadonlyArray<Row>, extra: (row: Row) => string = () => "", columns = COLUMNS): string {
  const all = [...rows, totalRow(rows, columns)];
  const header = ["trace", ...columns.map(([, title]) => title)];
  const cells = all.map((row) => [row.label, ...columns.map(([key]) => format(row[key]))]);
  const widths = header.map((title, i) => Math.max(title.length, ...cells.map((line) => line[i]!.length)));
  const line = (values: string[]) => values.map((value, i) => (i === 0 ? value.padEnd(widths[i]!) : value.padStart(widths[i]!))).join("  ");
  return [line(header), ...cells.map((values, i) => `${line(values)}${i < rows.length ? extra(all[i]!) : ""}`)].join("\n");
}

function delta(before: Row, after: Row): string {
  return [
    "metric      before    after    delta",
    ...COLUMNS.map(([key, title]) => {
      const change = (after[key] ?? 0) - (before[key] ?? 0);
      return `${title.padEnd(10)} ${format(before[key]).padStart(7)} ${format(after[key]).padStart(8)} ${`${change > 0 ? "+" : ""}${format(change)}`.padStart(8)}`;
    }),
  ].join("\n");
}

// Each trace replayed with its recorded reply; differs: the blocks are not the
// recorded ones. judge: the live judge reads each replay's inferences.
async function recorded(
  traces: ReadonlyArray<LabeledTrace>,
  update = false,
  judge = false,
): Promise<Array<{ key: string; label: string; metrics: SampleMetrics; differs: boolean; judge?: JudgedAnswer }>> {
  const results = [];
  for (const { key, label, file, trace } of traces) {
    const replayed = await replayRecorded(trace);
    if (update) writeFileSync(file, `${JSON.stringify(replayed, null, 2)}\n`);
    const judged = judge ? await judgeAnswer(trace.input, replayed.assertions, { env: liveEnv() }) : undefined;
    results.push({
      key,
      label,
      metrics: { ...answerMetrics(replayed), ...(judged ? judgeCounts(judged.verdicts) : {}) },
      differs: !isDeepStrictEqual(JSON.parse(JSON.stringify(replayed.blocks)), trace.blocks),
      ...(judged ? { judge: judged } : {}),
    });
  }
  return results;
}

// The stack's LLM settings, as dev-shell sets them.
function liveEnv(): Record<string, string | undefined> {
  return { ...process.env, LLM_SETTINGS_ENV_FILE: process.env.LLM_SETTINGS_ENV_FILE ?? join(ROOT, ".env.dev") };
}

function judgeCounts(verdicts: ReadonlyArray<InferenceVerdict>): JudgeCounts {
  const count = (verdict: InferenceVerdict["verdict"]) => verdicts.filter((entry) => entry.verdict === verdict).length;
  return { entailed: count("entailed"), not_entailed: count("not_entailed"), judge_error: count("error") };
}

export const RENDERING_MODES = ["on", "off", "recorded"] as const;
export type RenderingMode = (typeof RENDERING_MODES)[number];

// text: the model's raw reply; answer: the rich_text the user reads, each
// value as displayed; assertions: what rendering accepted, by kind, why the
// rest went, and how many accepted observations a comparison already showed.
type LiveSample = {
  trace: string;
  sample: number;
  deployment?: string;
  metrics?: SampleMetrics;
  text?: string;
  answer?: string;
  assertions?: { rendered: boolean; accepted: AssertionKind[]; rejected: string[]; repeated?: number };
  judge?: JudgedAnswer;
  error?: string;
};
// traces: the turns' keys; labels: their file names, for display.
type LiveRun = {
  run: string;
  samples: number;
  rendering?: RenderingMode;
  judged?: boolean;
  wall_ms: number;
  traces: string[];
  labels?: Record<string, string>;
  results: LiveSample[];
};

const GOLDEN_REPLIES = fileURLToPath(new URL("../test/golden/llm-replies.json", import.meta.url));

// Each traced question answered by its recorded reply. A reply matches by
// substring, so it keys on the answer request's own `"question":"..."` field:
// the question alone would match a later turn whose history repeats it. The
// golden fixture's thread-title reply goes first, as the title request quotes
// the question too.
export function replyFixture(traces: ReadonlyArray<LabeledTrace>, golden: LlmReplayFixture): LlmReplayFixture {
  const answers = traces.flatMap(({ trace }) =>
    trace.exchange?.text ? [{ match: `"question":${JSON.stringify(trace.question)}`, text: trace.exchange.text }] : []
  );
  return { replies: [...golden.replies.filter((reply) => reply.match.startsWith("Create a short")), ...answers] };
}

// The rich_text blocks as read: text as written, each ref its displayed value.
export function answerText(blocks: ReadonlyArray<Record<string, unknown>>): string {
  return blocks.filter((block) => block.kind === "rich_text")
    .map((block) => (Array.isArray(block.segments) ? block.segments as Array<{ type?: string; text?: string; format?: string }> : [])
      .map((segment) => (segment.type === "text" ? segment.text ?? "" : segment.format ?? "")).join(""))
    .join("\n\n");
}

async function live(traces: ReadonlyArray<LabeledTrace>, samples: number, concurrency: number, rendering: RenderingMode, judge = false): Promise<LiveRun> {
  const startedAt = Date.now();
  const jobs = traces.flatMap(({ key, label, trace }) => Array.from({ length: samples }, (_, sample) => ({ key, label, trace, sample })));
  const results: LiveSample[] = [];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { key, label, trace, sample } = job;
      try {
        const env = { ...liveEnv(), ...renderingEnv(rendering === "recorded" ? trace : { assertion_rendering: rendering === "on" }) };
        const answer = await composeTraced(trace.input, { env });
        // No deployment configured: the placeholder came back and no model answered.
        if (answer.exchange === null) throw new Error("no model was called (no deployable LLM in the settings)");
        const judged = judge ? await judgeAnswer(trace.input, answer.assertions, { env }) : undefined;
        results.push({
          trace: key,
          sample,
          deployment: answer.exchange?.deployment,
          metrics: { ...answerMetrics(answer), ...(judged ? judgeCounts(judged.verdicts) : {}) },
          text: answer.exchange?.text,
          answer: answerText(answer.blocks),
          ...(answer.assertions
            ? {
              assertions: {
                rendered: answer.assertions.rendered === true,
                accepted: answer.assertions.accepted.map((entry) => entry.kind),
                rejected: answer.assertions.rejected.map((entry) => entry.reason),
                ...(answer.assertions.repeated ? { repeated: answer.assertions.repeated.length } : {}),
              },
            }
            : {}),
          ...(judged ? { judge: judged } : {}),
        });
        console.log(`done  ${label} #${sample}  (${((answer.exchange?.latency_ms ?? 0) / 1000).toFixed(1)}s)`);
      } catch (error) {
        results.push({ trace: key, sample, error: failure(error) });
        console.log(`error ${label} #${sample}: ${failure(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const order = new Map(traces.map(({ key }, i) => [key, i]));
  results.sort((a, b) => order.get(a.trace)! - order.get(b.trace)! || a.sample - b.sample);
  return {
    run: new Date(startedAt).toISOString().slice(0, 19).replace(/:/g, ""),
    samples,
    rendering,
    ...(judge ? { judged: true } : {}),
    wall_ms: Date.now() - startedAt,
    traces: traces.map(({ key }) => key),
    labels: Object.fromEntries(traces.map(({ key, label }) => [key, label])),
    results,
  };
}

// Each attempt's deployment and code: the router's message alone names neither.
function failure(error: unknown): string {
  if (error instanceof LlmRouterError) {
    return `${error.message} (${error.attempts.map((attempt) => `${attempt.deployment.channel}/${attempt.deployment.model}: ${attempt.code}`).join("; ")})`;
  }
  return error instanceof Error ? error.message : String(error);
}

// How many answers were rendered, the kinds rendering accepted, and the
// rejections by reason, most frequent first.
export function assertionSummary(run: Pick<LiveRun, "results">): string {
  const answered = run.results.filter((result) => result.metrics);
  const count = (values: ReadonlyArray<string>) =>
    [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rendered = answered.filter((result) => result.assertions?.rendered).length;
  const kinds = count(answered.flatMap((result) => result.assertions?.accepted ?? []));
  const reasons = count(answered.flatMap((result) => result.assertions?.rejected ?? []));
  const repeated = answered.reduce((sum, result) => sum + (result.assertions?.repeated ?? 0), 0);
  return [
    `rendered: ${rendered} of ${answered.length} answers`,
    `accepted: ${kinds.map(([kind, n]) => `${n} ${kind}`).join(", ") || "none"}`,
    `repeated: ${repeated} observations a comparison already shows`,
    "rejected:",
    ...reasons.map(([reason, n]) => `  ${String(n).padStart(3)}  ${reason}`),
  ].join("\n");
}

// A row per trace with an answer; a trace whose every sample failed has none.
function liveRows(run: LiveRun, keys: ReadonlyArray<string> = run.traces): Row[] {
  return keys.flatMap((key) => {
    const answered = run.results.flatMap((result) => (result.trace === key && result.metrics ? [result.metrics] : []));
    return answered.length > 0 ? [meanRow({ key, label: run.labels?.[key] ?? key }, answered, columnsOf(run.judged === true))] : [];
  });
}

// The judge's verdicts over the run, its cost per judged answer, and each
// inference it did not find entailed, with its text and reason.
export function judgeSummary(run: Pick<LiveRun, "results" | "labels">): string {
  const judged = run.results.filter((result) => result.judge && result.judge.verdicts.length > 0);
  const verdicts = judged.flatMap((result) => result.judge!.verdicts);
  const counts = judgeCounts(verdicts);
  const called = judged.filter((result) => result.judge!.deployment !== null);
  const mean = (values: ReadonlyArray<number>) => (values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
  const flagged = judged.flatMap((result) =>
    result.judge!.verdicts.filter((verdict) => verdict.verdict !== "entailed").map((verdict) =>
      `  ${verdict.verdict === "error" ? "error" : "not entailed"}  ${run.labels?.[result.trace] ?? result.trace} #${result.sample} [${verdict.index}] ${verdict.text}\n      ${verdict.reason ?? "(no reason given)"}`
    )
  );
  return [
    `judge: ${counts.entailed} entailed, ${counts.not_entailed} not entailed, ${counts.judge_error} errors, of ${verdicts.length} inferences in ${judged.length} answers`,
    `judge per answer: ${mean(called.map((result) => result.judge!.latency_ms))} ms, ${mean(called.map((result) => result.judge!.usage?.input_tokens ?? 0))} in / ${mean(called.map((result) => result.judge!.usage?.output_tokens ?? 0))} out tokens, on ${[...new Set(called.map((result) => result.judge!.deployment))].join(", ") || "no model"}`,
    ...flagged,
  ].join("\n");
}

export const MUTATION_KINDS = ["worded_amount", "company_name", "unsupported_claim", "flipped_direction", "contradicted_ranking"] as const;
type MutationKind = (typeof MUTATION_KINDS)[number];
type MutationSet = {
  cases: Array<{
    id: string;
    // Relative to the set's file.
    trace: string;
    // The trace's assertion the case stands in place of.
    index: number;
    supports: number[];
    subject?: string;
    original: string;
    mutations: Array<{ kind: MutationKind; text: string }>;
  }>;
};

// One inference of the set as the judge reads it: an original, which its
// supports back, or a mutation, which they do not.
export type MutationVariant = { id: string; kind: "original" | MutationKind; judged: JudgeCase; companies: ReadonlyArray<string> };

// Each case's original and mutations on its trace's packet, through the
// turn's own checks. One the word rules reject is no gap of theirs, so it
// fails the set rather than inflate the catch rate.
export function mutationVariants(file: string): MutationVariant[] {
  const set = JSON.parse(readFileSync(file, "utf8")) as MutationSet;
  return set.cases.flatMap((entry) => {
    const trace = JSON.parse(readFileSync(resolve(dirname(file), entry.trace), "utf8")) as TurnTrace;
    const packet = turnPacket(trace.input);
    const factBlocks = trace.input.factBlocks ?? [];
    const list = splitAssertions(trace.exchange?.text ?? "").list;
    if (!Array.isArray(list) || entry.index >= list.length) throw new Error(`${entry.id}: ${entry.trace} has no assertion ${entry.index}`);
    const variants = [{ kind: "original" as const, text: entry.original }, ...entry.mutations];
    return variants.map(({ kind, text }) => {
      if (kind !== "original" && !MUTATION_KINDS.includes(kind)) throw new Error(`${entry.id}: unknown mutation kind ${JSON.stringify(kind)}`);
      const inference = { kind: "analyst_inference", text, evidence: [], supports: entry.supports, ...(entry.subject ? { subject: entry.subject } : {}) };
      const report = checkAssertions(list.with(entry.index, inference), packet, referenceTable(packet, factBlocks));
      const accepted = report.accepted.find((assertion) => assertion.index === entry.index);
      if (accepted?.supports?.length !== entry.supports.length) {
        const reason = report.rejected.find((rejection) => rejection.index === entry.index)?.reason ?? "a support was not accepted";
        throw new Error(`${entry.id} ${kind}: the turn's checks reject it (${reason}); the set holds only inferences they pass`);
      }
      return { id: entry.id, kind, judged: judgeCases(report.accepted, packet, factBlocks).find((judged) => judged.index === entry.index)!, companies: packet.companies };
    });
  });
}

type MutationResult = { id: string; kind: MutationVariant["kind"]; text: string; verdict: InferenceVerdict; deployment: string | null; latency_ms: number; usage?: JudgeOutcome["usage"] };

// Each inference judged alone, as an answer of one.
async function judgeMutations(variants: ReadonlyArray<MutationVariant>, concurrency: number): Promise<MutationResult[]> {
  const jobs = [...variants];
  const results: MutationResult[] = [];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { id, kind, judged, companies } = job;
      const { verdicts, ...outcome } = await judgeInferences({ cases: [judged], companies, env: liveEnv() });
      results.push({ id, kind, text: judged.text, verdict: verdicts[0]!, ...outcome });
      console.log(`${verdicts[0]!.verdict.padEnd(12)} ${id} ${kind}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return variants.map((variant) => results.find((result) => result.id === variant.id && result.text === variant.judged.text)!);
}

// Mutations caught (not entailed) and originals flagged, by kind; an error is
// neither, and is counted on its own.
export function mutationSummary(results: ReadonlyArray<Pick<MutationResult, "id" | "kind" | "text" | "verdict">>): string {
  const rate = (rows: ReadonlyArray<Pick<MutationResult, "verdict">>, verdict: InferenceVerdict["verdict"]) =>
    `${rows.filter((row) => row.verdict.verdict === verdict).length} of ${rows.length}`;
  const errors = (rows: ReadonlyArray<Pick<MutationResult, "verdict">>) => rows.filter((row) => row.verdict.verdict === "error").length;
  const mutations = results.filter((result) => result.kind !== "original");
  const originals = results.filter((result) => result.kind === "original");
  const missed = results.filter((result) => (result.kind === "original" ? result.verdict.verdict !== "entailed" : result.verdict.verdict !== "not_entailed"));
  return [
    `caught: ${rate(mutations, "not_entailed")} mutations (${errors(mutations)} errors)`,
    ...MUTATION_KINDS.map((kind) => `  ${kind.padEnd(22)} ${rate(mutations.filter((result) => result.kind === kind), "not_entailed")}`),
    `false alarms: ${rate(originals, "not_entailed")} originals (${errors(originals)} errors)`,
    ...(missed.length > 0 ? ["misses, false alarms and errors:"] : []),
    ...missed.map((result) => `  ${result.id} ${result.kind}: ${result.verdict.verdict}${result.verdict.reason ? ` (${result.verdict.reason})` : ""}\n      ${result.text}`),
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      update: { type: "boolean", default: false },
      samples: { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      against: { type: "string" },
      rendering: { type: "string", default: "recorded" },
      out: { type: "string" },
      judge: { type: "boolean", default: false },
    },
  });
  const [mode, ...paths] = positionals;
  if (
    (mode !== "recorded" && mode !== "live" && mode !== "replies" && mode !== "judge-mutations") || paths.length === 0 ||
    (mode === "replies" && !values.out) || (mode === "judge-mutations" && paths.length !== 1)
  ) {
    console.error("usage: answer-lab.ts recorded <trace dir|files...> [--check | --update] [--judge] | live <trace dir|files...> [--samples K] [--concurrency N] [--rendering on|off|recorded] [--against <run.json>] [--judge] | replies <trace dir|files...> --out <file> | judge-mutations <set.json> [--concurrency N]");
    return 2;
  }
  if (mode === "judge-mutations") {
    let variants: MutationVariant[];
    try {
      variants = mutationVariants(paths[0]!);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const startedAt = Date.now();
    const results = await judgeMutations(variants, Math.max(1, Number.parseInt(values.concurrency, 10) || 1));
    const run = new Date(startedAt).toISOString().slice(0, 19).replace(/:/g, "");
    mkdirSync(RUNS_DIR, { recursive: true });
    const file = join(RUNS_DIR, `${run}.judge-mutations.json`);
    writeFileSync(file, `${JSON.stringify({ run, set: paths[0], wall_ms: Date.now() - startedAt, results }, null, 2)}\n`, { flag: "wx" });
    const called = results.filter((result) => result.deployment !== null);
    const mean = (values: ReadonlyArray<number>) => (values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
    console.log(`\n${mutationSummary(results)}\n\njudged on ${[...new Set(called.map((result) => result.deployment))].join(", ") || "no model"}: ${mean(called.map((result) => result.latency_ms))} ms, ${mean(called.map((result) => result.usage?.input_tokens ?? 0))} in / ${mean(called.map((result) => result.usage?.output_tokens ?? 0))} out tokens per inference; ${file}`);
    return results.some((result) => result.verdict.verdict === "error") ? 1 : 0;
  }
  let traces: LabeledTrace[];
  try {
    traces = readTraces(paths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (mode === "replies") {
    const golden = JSON.parse(readFileSync(GOLDEN_REPLIES, "utf8")) as LlmReplayFixture;
    writeFileSync(values.out!, `${JSON.stringify(replyFixture(traces, golden), null, 2)}\n`);
    console.log(`${traces.length} traced replies written to ${values.out}`);
    return 0;
  }
  if (mode === "recorded") {
    const results = await recorded(traces, values.update, values.judge);
    const differs = new Set(results.filter((result) => result.differs).map((result) => result.key));
    const columns = columnsOf(values.judge);
    console.log(table(results.map((result) => meanRow(result, [result.metrics], columns)), (row) => (differs.has(row.key) ? "  DIFFERS" : ""), columns));
    console.log(`\n${traces.length - differs.size} of ${traces.length} replayed to the recorded blocks`);
    // Verdicts the shadow judge recorded on the turns as they ran (#302).
    const shadowed = traces.flatMap(({ key, trace }) => (trace.judge ? [{ trace: key, sample: 0, judge: trace.judge }] : []));
    if (shadowed.length > 0) {
      console.log(`\nrecorded in shadow, ${judgeSummary({ results: shadowed, labels: Object.fromEntries(traces.map(({ key, label }) => [key, label])) })}`);
    }
    if (values.judge) {
      const run: LiveRun = {
        run: new Date().toISOString().slice(0, 19).replace(/:/g, ""),
        samples: 1,
        judged: true,
        wall_ms: 0,
        traces: traces.map(({ key }) => key),
        labels: Object.fromEntries(traces.map(({ key, label }) => [key, label])),
        results: results.map(({ key, metrics, judge }) => ({ trace: key, sample: 0, metrics, ...(judge ? { judge } : {}) })),
      };
      mkdirSync(RUNS_DIR, { recursive: true });
      const file = join(RUNS_DIR, `${run.run}.recorded-judge.json`);
      writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
      console.log(`\n${judgeSummary(run)}\n${file}`);
    }
    return values.check && differs.size > 0 ? 1 : 0;
  }
  const samples = Number.parseInt(values.samples, 10);
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!(samples > 0) || !(concurrency > 0)) {
    console.error("--samples and --concurrency take a positive integer");
    return 2;
  }
  const rendering = values.rendering as RenderingMode;
  if (!RENDERING_MODES.includes(rendering)) {
    console.error(`--rendering takes ${RENDERING_MODES.join(", ")}`);
    return 2;
  }
  // Read before the model is called, so a baseline that cannot match costs no run.
  const before = values.against === undefined ? undefined : JSON.parse(readFileSync(values.against, "utf8")) as LiveRun;
  // A run from before traces were keyed by turn names them by file: nothing would match.
  if (before && before.labels === undefined) {
    console.error(`${values.against} is from an older answer-lab whose traces are not keyed by turn; rerun it`);
    return 2;
  }
  const run = await live(traces, samples, concurrency, rendering, values.judge);
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${run.run}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
  const rows = liveRows(run);
  const errors = run.results.filter((result) => result.error).length;
  const unanswered = run.traces.filter((key) => !rows.some((row) => row.key === key)).map((key) => run.labels?.[key] ?? key);
  console.log(`\n${table(rows, undefined, columnsOf(values.judge))}\n\n${assertionSummary(run)}${values.judge ? `\n\n${judgeSummary(run)}` : ""}\n\n${run.results.length - errors} answers, ${errors} errors, rendering ${rendering}, ${(run.wall_ms / 1000).toFixed(1)}s wall; ${file}`);
  if (unanswered.length > 0) console.log(`no answer: ${unanswered.join(", ")}`);
  if (before) {
    // Only traces both runs answered, so a failed one does not read as a change.
    const shared = liveRows(before).map((row) => row.key).filter((key) => rows.some((row) => row.key === key));
    console.log(`\nagainst ${values.against}, over the ${shared.length} traces both answered:\n${delta(totalRow(liveRows(before, shared)), totalRow(liveRows(run, shared)))}`);
  }
  return errors > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
