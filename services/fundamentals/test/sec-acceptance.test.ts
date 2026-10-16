import assert from "node:assert/strict";
import test from "node:test";
import { parseSecAcceptance } from "../src/sec-acceptance.ts";

test("an acceptance time is the Eastern wall clock, whatever its trailing Z says", () => {
  assert.deepEqual(parseSecAcceptance("2024-11-01T18:04:43.000Z"), { parsed_at: "2024-11-01T22:04:43.000Z", timing_precision: "instant" });
  assert.deepEqual(parseSecAcceptance("2024-02-01T16:30:05.000Z"), { parsed_at: "2024-02-01T21:30:05.000Z", timing_precision: "instant" });
  assert.deepEqual(parseSecAcceptance("2024-02-01T16:30:05Z"), { parsed_at: "2024-02-01T21:30:05.000Z", timing_precision: "instant" });
});

test("a bare date is date precision, bounded by the end of its Eastern day", () => {
  assert.deepEqual(parseSecAcceptance("2024-11-01"), { parsed_at: "2024-11-02T03:59:59.999Z", timing_precision: "date" });
  assert.deepEqual(parseSecAcceptance("2024-01-10"), { parsed_at: "2024-01-11T04:59:59.999Z", timing_precision: "date" });
});

test("malformed values and Eastern times a DST change skips or repeats stay unknown", () => {
  const unknown = { parsed_at: null, timing_precision: null };
  for (const raw of [
    "",
    "2024-11-01 18:04:43",
    "2024-11-01T18:04:43.000+00:00",
    "20241101180443",
    "2024-02-30T10:00:00.000Z",
    "2024-02-30",
    "2024-11-01T24:00:00.000Z",
    "null",
    "2024-03-10T02:30:00.000Z",
    "2024-11-03T01:30:00.000Z",
  ]) {
    assert.deepEqual(parseSecAcceptance(raw), unknown, raw);
  }
});
