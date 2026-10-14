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

test("two traces with one file name are told apart by their paths", () => {
  const [first] = TRACES;
  const dirs = ["a", "b"].map((name) => join(mkdtempSync(join(tmpdir(), "answer-lab-")), name));
  for (const dir of dirs) {
    mkdirSync(dir);
    writeFileSync(join(dir, "run.json"), JSON.stringify(first!.trace));
  }
  const labels = readTraces(dirs.map((dir) => join(dir, "run.json"))).map(({ label }) => label);
  assert.deepEqual(labels, dirs.map((dir) => join(dir, "run")));
});

test("labels do not depend on the order traces are given in", () => {
  const [first] = TRACES;
  const root = mkdtempSync(join(tmpdir(), "answer-lab-"));
  for (const file of ["fixtures/baseline/run.json", "fixtures/baseline/run#3.json", "baseline/run.json", "candidate/run.json", "unrelated.json"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(first!.trace));
  }
  const inputs = ["fixtures", "baseline/run.json", "candidate/run.json", "unrelated.json"].map((path) => join(root, path));
  const byLabel = (paths: string[]) => readTraces(paths).map(({ label }) => label).sort();
  assert.equal(new Set(byLabel(inputs)).size, 5);
  assert.deepEqual(byLabel([inputs[3]!, ...inputs.slice(0, 3)]), byLabel(inputs));
});

test("a label made from a path stays unique beside a directory's own label", () => {
  const [first] = TRACES;
  const root = mkdtempSync(join(tmpdir(), "answer-lab-"));
  for (const dir of ["baseline", "candidate", "fixtures/baseline"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "run.json"), JSON.stringify(first!.trace));
  }
  const labels = readTraces([join(root, "baseline/run.json"), join(root, "candidate/run.json"), join(root, "fixtures")]).map(({ label }) => label);
  assert.equal(new Set(labels).size, 3);
});
