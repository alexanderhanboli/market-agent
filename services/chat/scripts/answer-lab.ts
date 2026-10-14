// Answer lab: re-runs recorded answer turns (services/chat/src/answer-trace.ts)
// through today's post-processing, with the recorded model reply (recorded) or
// fresh replies from the live model (live), and tabulates what the answer shows.
//
//   node --experimental-strip-types scripts/answer-lab.ts recorded <trace dir|files...> [--check]
//   node --experimental-strip-types scripts/answer-lab.ts live <trace dir|files...> [--samples K] [--concurrency N] [--against <run.json>]
//
// recorded is deterministic and offline; --check exits 1 when a replay's blocks
// differ from the recorded ones. live uses the stack's LLM settings
// (LLM_SETTINGS_ENV_FILE, default .env.dev, as dev-shell sets it) and writes
// docs/eval-runs/answer-lab/<stamp>.json.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

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

export type LabeledTrace = { label: string; trace: TurnTrace };

// Every *.json under each path (a trace or a directory of them), labelled by
// its path below the directory it was found in, without .json.
export function readTraces(paths: ReadonlyArray<string>): LabeledTrace[] {
  return paths.flatMap((path) => {
    const files = statSync(path).isDirectory()
      ? readdirSync(path, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json")).sort().map((name) => join(path, name))
      : [path];
    return files.map((file) => ({
      label: (statSync(path).isDirectory() ? relative(path, file) : basename(file)).replace(/\.json$/, ""),
      trace: JSON.parse(readFileSync(file, "utf8")) as TurnTrace,
    }));
  });
}

type Row = { label: string } & { [K in keyof AnswerMetrics]: number };
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
function meanRow(label: string, samples: ReadonlyArray<AnswerMetrics>): Row {
  const mean = (key: keyof AnswerMetrics) =>
    samples.length === 0 ? 0 : samples.reduce((sum, metrics) => sum + Number(metrics[key]), 0) / samples.length;
  return Object.fromEntries([["label", label], ...COLUMNS.map(([key]) => [key, mean(key)])]) as Row;
}

// Counts add up across traces; tokens and latency are per answer.
function totalRow(rows: ReadonlyArray<Row>): Row {
  const total = Object.fromEntries([["label", "total"], ...COLUMNS.map(([key]) => [key, rows.reduce((sum, row) => sum + row[key], 0)])]) as Row;
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
async function recorded(traces: ReadonlyArray<LabeledTrace>): Promise<Array<{ label: string; metrics: AnswerMetrics; differs: boolean }>> {
  const results = [];
  for (const { label, trace } of traces) {
    const replayed = await replayRecorded(trace);
    results.push({
      label,
      metrics: answerMetrics(replayed),
      differs: !isDeepStrictEqual(JSON.parse(JSON.stringify(replayed.blocks)), trace.blocks),
    });
  }
  return results;
}

type LiveSample = { trace: string; sample: number; deployment?: string; metrics?: AnswerMetrics; text?: string; error?: string };
type LiveRun = { run: string; samples: number; wall_ms: number; traces: string[]; results: LiveSample[] };

async function live(traces: ReadonlyArray<LabeledTrace>, samples: number, concurrency: number): Promise<LiveRun> {
  const startedAt = Date.now();
  const jobs = traces.flatMap(({ label, trace }) => Array.from({ length: samples }, (_, sample) => ({ label, trace, sample })));
  const results: LiveSample[] = [];
  const settingsFile = process.env.LLM_SETTINGS_ENV_FILE ?? join(ROOT, ".env.dev");
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { label, trace, sample } = job;
      try {
        const answer = await composeTraced(trace.input, {
          env: { ...process.env, LLM_SETTINGS_ENV_FILE: settingsFile, ...renderingEnv(trace) },
        });
        results.push({
          trace: label,
          sample,
          deployment: answer.exchange?.deployment,
          metrics: answerMetrics(answer),
          text: answer.exchange?.text,
        });
        console.log(`done  ${label} #${sample}  (${((answer.exchange?.latency_ms ?? 0) / 1000).toFixed(1)}s)`);
      } catch (error) {
        results.push({ trace: label, sample, error: error instanceof Error ? error.message : String(error) });
        console.log(`error ${label} #${sample}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const order = new Map(traces.map(({ label }, i) => [label, i]));
  results.sort((a, b) => order.get(a.trace)! - order.get(b.trace)! || a.sample - b.sample);
  return {
    run: new Date(startedAt).toISOString().slice(0, 19).replace(/:/g, ""),
    samples,
    wall_ms: Date.now() - startedAt,
    traces: traces.map(({ label }) => label),
    results,
  };
}

function liveRows(run: LiveRun): Row[] {
  return run.traces.map((label) =>
    meanRow(label, run.results.flatMap((result) => (result.trace === label && result.metrics ? [result.metrics] : [])))
  );
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      samples: { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      against: { type: "string" },
    },
  });
  const [mode, ...paths] = positionals;
  if ((mode !== "recorded" && mode !== "live") || paths.length === 0) {
    console.error("usage: answer-lab.ts recorded <trace dir|files...> [--check] | live <trace dir|files...> [--samples K] [--concurrency N] [--against <run.json>]");
    return 2;
  }
  const traces = readTraces(paths);
  if (mode === "recorded") {
    const results = await recorded(traces);
    const differs = new Set(results.filter((result) => result.differs).map((result) => result.label));
    console.log(table(results.map(({ label, metrics }) => meanRow(label, [metrics])), (row) => (differs.has(row.label) ? "  DIFFERS" : "")));
    console.log(`\n${traces.length - differs.size} of ${traces.length} replayed to the recorded blocks`);
    return values.check && differs.size > 0 ? 1 : 0;
  }
  const samples = Number.parseInt(values.samples, 10);
  const concurrency = Number.parseInt(values.concurrency, 10);
  if (!(samples > 0) || !(concurrency > 0)) {
    console.error("--samples and --concurrency take a positive integer");
    return 2;
  }
  const run = await live(traces, samples, concurrency);
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${run.run}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
  const rows = liveRows(run);
  const errors = run.results.filter((result) => result.error).length;
  console.log(`\n${table(rows)}\n\n${run.results.length - errors} answers, ${errors} errors, ${(run.wall_ms / 1000).toFixed(1)}s wall; ${file}`);
  if (values.against) {
    const before = JSON.parse(readFileSync(values.against, "utf8")) as LiveRun;
    console.log(`\nagainst ${values.against}:\n${delta(totalRow(liveRows(before)), totalRow(rows))}`);
  }
  return errors > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
