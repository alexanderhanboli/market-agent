// Answer lab: re-runs recorded answer turns (services/chat/src/answer-trace.ts)
// through today's post-processing, with the recorded model reply (recorded) or
// fresh replies from the live model (live), and tabulates what the answer shows.
//
//   node --experimental-strip-types scripts/answer-lab.ts recorded <trace dir|files...> [--check | --update]
//   node --experimental-strip-types scripts/answer-lab.ts live <trace dir|files...> [--samples K] [--concurrency N] [--against <run.json>]
//
// recorded is deterministic and offline; --check exits 1 when a replay's blocks
// differ from the recorded ones; --update writes each replay over its trace
// (blocks, removals, assertions), for a deliberate change to post-processing. live uses the stack's LLM settings
// (LLM_SETTINGS_ENV_FILE, default .env.dev, as dev-shell sets it) and writes
// docs/eval-runs/answer-lab/<stamp>.json.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { LlmRouterError } from "../../llm/src/index.ts";
import {
  answerMetrics,
  composeTraced,
  renderingEnv,
  replayRecorded,
  type AnswerMetrics,
  type TurnTrace,
} from "../src/answer-trace.ts";

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

type Row = { key: string; label: string } & { [K in keyof AnswerMetrics]: number };
const COLUMNS: ReadonlyArray<[keyof AnswerMetrics, string]> = [
  ["figure_refs", "refs"],
  ["plain_numbers", "plain#"],
  ["removed", "removed"],
  ["fallback", "fallback"],
  ["accepted", "accepted"],
  ["rejected", "rejected"],
  ["output_tokens", "out tok"],
  ["latency_ms", "latency ms"],
];

// A trace's row: the mean of its samples.
function meanRow(trace: { key: string; label: string }, samples: ReadonlyArray<AnswerMetrics>): Row {
  const mean = (key: keyof AnswerMetrics) =>
    samples.length === 0 ? 0 : samples.reduce((sum, metrics) => sum + Number(metrics[key]), 0) / samples.length;
  return Object.fromEntries([["key", trace.key], ["label", trace.label], ...COLUMNS.map(([key]) => [key, mean(key)])]) as Row;
}

// Counts add up across traces; tokens and latency are per answer.
function totalRow(rows: ReadonlyArray<Row>): Row {
  const total = Object.fromEntries([["key", ""], ["label", "total"], ...COLUMNS.map(([key]) => [key, rows.reduce((sum, row) => sum + row[key], 0)])]) as Row;
  if (rows.length > 0) {
    total.output_tokens /= rows.length;
    total.latency_ms /= rows.length;
  }
  return total;
}

const format = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function table(rows: ReadonlyArray<Row>, extra: (row: Row) => string = () => ""): string {
  const all = [...rows, totalRow(rows)];
  const header = ["trace", ...COLUMNS.map(([, title]) => title)];
  const cells = all.map((row) => [row.label, ...COLUMNS.map(([key]) => format(row[key]))]);
  const widths = header.map((title, i) => Math.max(title.length, ...cells.map((line) => line[i]!.length)));
  const line = (values: string[]) => values.map((value, i) => (i === 0 ? value.padEnd(widths[i]!) : value.padStart(widths[i]!))).join("  ");
  return [line(header), ...cells.map((values, i) => `${line(values)}${i < rows.length ? extra(all[i]!) : ""}`)].join("\n");
}

function delta(before: Row, after: Row): string {
  return [
    "metric      before    after    delta",
    ...COLUMNS.map(([key, title]) => {
      const change = after[key] - before[key];
      return `${title.padEnd(10)} ${format(before[key]).padStart(7)} ${format(after[key]).padStart(8)} ${`${change > 0 ? "+" : ""}${format(change)}`.padStart(8)}`;
    }),
  ].join("\n");
}

// Each trace replayed with its recorded reply; differs: the blocks are not the
// recorded ones.
async function recorded(traces: ReadonlyArray<LabeledTrace>, update = false): Promise<Array<{ key: string; label: string; metrics: AnswerMetrics; differs: boolean }>> {
  const results = [];
  for (const { key, label, file, trace } of traces) {
    const replayed = await replayRecorded(trace);
    if (update) writeFileSync(file, `${JSON.stringify(replayed, null, 2)}\n`);
    results.push({
      key,
      label,
      metrics: answerMetrics(replayed),
      differs: !isDeepStrictEqual(JSON.parse(JSON.stringify(replayed.blocks)), trace.blocks),
    });
  }
  return results;
}

type LiveSample = { trace: string; sample: number; deployment?: string; metrics?: AnswerMetrics; text?: string; error?: string };
// traces: the turns' keys; labels: their file names, for display.
type LiveRun = { run: string; samples: number; wall_ms: number; traces: string[]; labels?: Record<string, string>; results: LiveSample[] };

async function live(traces: ReadonlyArray<LabeledTrace>, samples: number, concurrency: number): Promise<LiveRun> {
  const startedAt = Date.now();
  const jobs = traces.flatMap(({ key, label, trace }) => Array.from({ length: samples }, (_, sample) => ({ key, label, trace, sample })));
  const results: LiveSample[] = [];
  const settingsFile = process.env.LLM_SETTINGS_ENV_FILE ?? join(ROOT, ".env.dev");
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { key, label, trace, sample } = job;
      try {
        const answer = await composeTraced(trace.input, {
          env: { ...process.env, LLM_SETTINGS_ENV_FILE: settingsFile, ...renderingEnv(trace) },
        });
        // No deployment configured: the placeholder came back and no model answered.
        if (answer.exchange === null) throw new Error("no model was called (no deployable LLM in the settings)");
        results.push({
          trace: key,
          sample,
          deployment: answer.exchange?.deployment,
          metrics: answerMetrics(answer),
          text: answer.exchange?.text,
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

// A row per trace with an answer; a trace whose every sample failed has none.
function liveRows(run: LiveRun, keys: ReadonlyArray<string> = run.traces): Row[] {
  return keys.flatMap((key) => {
    const answered = run.results.flatMap((result) => (result.trace === key && result.metrics ? [result.metrics] : []));
    return answered.length > 0 ? [meanRow({ key, label: run.labels?.[key] ?? key }, answered)] : [];
  });
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
    },
  });
  const [mode, ...paths] = positionals;
  if ((mode !== "recorded" && mode !== "live") || paths.length === 0) {
    console.error("usage: answer-lab.ts recorded <trace dir|files...> [--check | --update] | live <trace dir|files...> [--samples K] [--concurrency N] [--against <run.json>]");
    return 2;
  }
  let traces: LabeledTrace[];
  try {
    traces = readTraces(paths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (mode === "recorded") {
    const results = await recorded(traces, values.update);
    const differs = new Set(results.filter((result) => result.differs).map((result) => result.key));
    console.log(table(results.map((result) => meanRow(result, [result.metrics])), (row) => (differs.has(row.key) ? "  DIFFERS" : "")));
    console.log(`\n${traces.length - differs.size} of ${traces.length} replayed to the recorded blocks`);
    return values.check && differs.size > 0 ? 1 : 0;
  }
  const samples = Number.parseInt(values.samples, 10);
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!(samples > 0) || !(concurrency > 0)) {
    console.error("--samples and --concurrency take a positive integer");
    return 2;
  }
  // Read before the model is called, so a baseline that cannot match costs no run.
  const before = values.against === undefined ? undefined : JSON.parse(readFileSync(values.against, "utf8")) as LiveRun;
  // A run from before traces were keyed by turn names them by file: nothing would match.
  if (before && before.labels === undefined) {
    console.error(`${values.against} is from an older answer-lab whose traces are not keyed by turn; rerun it`);
    return 2;
  }
  const run = await live(traces, samples, concurrency);
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${run.run}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
  const rows = liveRows(run);
  const errors = run.results.filter((result) => result.error).length;
  const unanswered = run.traces.filter((key) => !rows.some((row) => row.key === key)).map((key) => run.labels?.[key] ?? key);
  console.log(`\n${table(rows)}\n\n${run.results.length - errors} answers, ${errors} errors, ${(run.wall_ms / 1000).toFixed(1)}s wall; ${file}`);
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
