import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { perfLines } from "../src/perf-points.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const daily = (closes: number[]) => closes.map((close, index) => ({ ts: `2026-08-${22 + index}T00:00:00.000Z`, close }));
// New York sessions stamped at local midnight.
const ny = (date: string, close: number) => ({ ts: `${date}T${date >= "2026-03-08" ? "04" : "05"}:00:00.000Z`, close });

test("latest window: percent return from the first shared close, digest over every stored bar", () => {
  assert.deepEqual(perfLines({ kind: "latest", bars: [daily([100, 110, 121]), daily([50, 45, 55])] }), {
    ok: true,
    lines: [
      {
        points: [{ x: "2026-08-22", y: 0 }, { x: "2026-08-23", y: 10.000000000000009 }, { x: "2026-08-24", y: 20.999999999999996 }],
        bars_sha256: sha256('[["2026-08-22T00:00:00.000Z",100],["2026-08-23T00:00:00.000Z",110],["2026-08-24T00:00:00.000Z",121]]'),
      },
      {
        points: [{ x: "2026-08-22", y: 0 }, { x: "2026-08-23", y: -9.999999999999998 }, { x: "2026-08-24", y: 10.000000000000009 }],
        bars_sha256: sha256('[["2026-08-22T00:00:00.000Z",50],["2026-08-23T00:00:00.000Z",45],["2026-08-24T00:00:00.000Z",55]]'),
      },
    ],
  });
});

test("latest window: fewer than two shared dates is a gap", () => {
  assert.deepEqual(perfLines({ kind: "latest", bars: [daily([100, 110]), [{ ts: "2026-08-22T00:00:00.000Z", close: 50 }]] }), {
    ok: false,
    gap: "fewer than two dates every company has",
  });
});

test("YTD: returns from the baseline close on session dates, digest over only the window's bars", () => {
  const drawn = perfLines({
    kind: "ytd",
    cutoff: "2026-09-01T00:00:00.000Z",
    series: [
      { label: "NVDA", timeZone: "America/New_York", bars: [ny("2025-12-31", 100), ny("2026-01-02", 110), ny("2026-08-31", 120)] },
      { label: "AMD", timeZone: "America/New_York", bars: [ny("2025-12-30", 40), ny("2025-12-31", 50), ny("2026-01-02", 45), ny("2026-08-31", 60)] },
    ],
  });
  assert.equal(drawn.ok, true);
  assert.deepEqual(drawn.ok && drawn.lines, [
    {
      points: [{ x: "2025-12-31", y: 0 }, { x: "2026-01-02", y: 10 }, { x: "2026-08-31", y: 20 }],
      bars_sha256: sha256('[["2025-12-31T05:00:00.000Z",100],["2026-01-02T05:00:00.000Z",110],["2026-08-31T04:00:00.000Z",120]]'),
    },
    {
      points: [{ x: "2025-12-31", y: 0 }, { x: "2026-01-02", y: -10 }, { x: "2026-08-31", y: 20 }],
      bars_sha256: sha256('[["2025-12-31T05:00:00.000Z",50],["2026-01-02T05:00:00.000Z",45],["2026-08-31T04:00:00.000Z",60]]'),
    },
  ]);
  assert.deepEqual(drawn.ok && [drawn.window.baselineDate, drawn.window.endDate], ["2025-12-31", "2026-08-31"]);
});
