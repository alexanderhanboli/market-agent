import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { replayRecorded } from "../src/answer-trace.ts";
import { readTraces } from "../scripts/answer-lab.ts";

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
