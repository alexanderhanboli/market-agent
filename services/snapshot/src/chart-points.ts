// A price chart's drawn points are what its sealed series produce (#236). Each
// line i is drawn from data_ref.params.series_refs[i], whose manifest spec pins
// a stored bar range and the digest of its bars. The seal reloads those bars
// through its database client, in one statement, recomputes every line with the
// function chat draws with (perf-points.ts), and requires the digests and the
// points to match exactly. The cache replaces a range's bars in place when it
// refreshes, so this holds at seal time only; read-back trusts the seal.

import { isDeepStrictEqual } from "node:util";

import { perfLines, type PerfLine } from "../../market/src/perf-points.ts";
import { sessionDate, windowClosedAt, type DailyClose } from "../../market/src/ytd-window.ts";
import type { JsonValue, QueryExecutor } from "./manifest-staging.ts";

export type ChartPointsReason = "count" | "duplicate" | "unverifiable" | "window" | "hash" | "points";

export type ChartPointsFailure = { block_id: string; series_ref: string | null; reason: ChartPointsReason };

export type DrawnChart = {
  block_id: string;
  series_refs: ReadonlyArray<string>;
  series: ReadonlyArray<{ points: unknown }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SealedWindow = { year: number; baseline_date: string; end_date: string };

type SealedSeries = {
  bar_range_id: string;
  listing_id: string;
  bars_sha256: string;
  window: SealedWindow | null;
};

// One drawn line and the sealed series it claims to be.
type ChartLine = { series_ref: string; spec: SealedSeries; points: unknown };

export async function verifyChartPoints(
  charts: ReadonlyArray<DrawnChart>,
  seriesSpecs: ReadonlyArray<JsonValue>,
  db: QueryExecutor | undefined,
): Promise<ChartPointsFailure[]> {
  const specs = new Map(
    seriesSpecs.flatMap((spec) => isRecord(spec) && typeof spec.series_ref === "string" ? [[spec.series_ref, spec] as const] : []),
  );
  const failures: ChartPointsFailure[] = [];
  for (const chart of charts) {
    const fail = (reason: ChartPointsReason, series_ref: string | null = null) =>
      failures.push({ block_id: chart.block_id, series_ref, reason });
    if (chart.series.length !== chart.series_refs.length || chart.series_refs.some((ref) => !specs.has(ref))) {
      fail("count");
      continue;
    }
    const duplicate = chart.series_refs.find((ref, index) => chart.series_refs.indexOf(ref) !== index);
    if (duplicate !== undefined) {
      fail("duplicate", duplicate);
      continue;
    }
    const lines: ChartLine[] = [];
    for (const [index, series_ref] of chart.series_refs.entries()) {
      const spec = sealedSeries(specs.get(series_ref)!);
      if (spec === null) fail("unverifiable", series_ref);
      else lines.push({ series_ref, spec, points: chart.series[index].points });
    }
    if (lines.length !== chart.series.length || lines.length === 0) continue;
    if (db === undefined) {
      fail("unverifiable");
      continue;
    }
    const outcome = await recompute(db, lines);
    if (typeof outcome === "string") {
      fail(outcome);
      continue;
    }
    for (const [index, line] of lines.entries()) {
      if (outcome[index].bars_sha256 !== line.spec.bars_sha256) fail("hash", line.series_ref);
      else if (!isDeepStrictEqual(outcome[index].points, line.points)) fail("points", line.series_ref);
    }
  }
  return failures;
}

// Every line, recomputed from the bars its spec pins, in the mode it was drawn in.
async function recompute(
  db: QueryExecutor,
  lines: ReadonlyArray<ChartLine>,
): Promise<ReadonlyArray<PerfLine> | "window" | "unverifiable"> {
  const [{ spec: { window } }] = lines;
  if (lines.some((line) => !isDeepStrictEqual(line.spec.window, window))) return "window";
  const bars = await loadBars(db, lines.map((line) => line.spec.bar_range_id));
  const barsOf = (line: ChartLine) => bars.get(line.spec.bar_range_id) ?? [];
  if (window === null) {
    const drawn = perfLines({ kind: "latest", bars: lines.map(barsOf) });
    return drawn.ok ? drawn.lines : "window";
  }
  const zones = await loadTimeZones(db, lines.map((line) => line.spec.listing_id));
  if (lines.some((line) => !zones.has(line.spec.listing_id))) return "unverifiable";
  const zoneOf = (line: ChartLine) => zones.get(line.spec.listing_id)!;
  // Sessions stored since the window ended are not part of it.
  const drawn = perfLines({
    kind: "ytd",
    series: lines.map((line) => ({
      label: line.series_ref,
      timeZone: zoneOf(line),
      bars: barsOf(line).filter((bar) => sessionDate(bar.ts, zoneOf(line)) <= window.end_date),
    })),
    cutoff: windowClosedAt(window.end_date, lines.map(zoneOf)),
  });
  if (
    !drawn.ok ||
    drawn.window.year !== window.year ||
    drawn.window.baselineDate !== window.baseline_date ||
    drawn.window.endDate !== window.end_date
  ) {
    return "window";
  }
  return drawn.lines;
}

async function loadBars(db: QueryExecutor, barRangeIds: ReadonlyArray<string>): Promise<Map<string, DailyClose[]>> {
  const { rows } = await db.query<{ bar_range_id: string; ts: Date | string; close: number }>(
    `select bar_range_id::text as bar_range_id, ts, close::float8 as close
       from market_bars
      where bar_range_id = any($1::uuid[])
      order by bar_range_id, ts`,
    [[...new Set(barRangeIds)]],
  );
  const bars = new Map<string, DailyClose[]>();
  for (const row of rows) {
    const range = bars.get(row.bar_range_id) ?? [];
    range.push({ ts: new Date(row.ts).toISOString(), close: row.close });
    bars.set(row.bar_range_id, range);
  }
  return bars;
}

async function loadTimeZones(db: QueryExecutor, listingIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const { rows } = await db.query<{ listing_id: string; timezone: string }>(
    `select listing_id::text as listing_id, timezone from listings where listing_id = any($1::uuid[])`,
    [[...new Set(listingIds)]],
  );
  return new Map(rows.map((row) => [row.listing_id, row.timezone]));
}

// The fields the check reads, or null when the spec cannot be checked: only
// daily percent returns are drawn this way.
function sealedSeries(spec: Record<string, unknown>): SealedSeries | null {
  const { bar_range_id, listing_id, bars_sha256, interval, normalization, window } = spec;
  if (
    typeof bar_range_id !== "string" ||
    !UUID.test(bar_range_id) ||
    typeof listing_id !== "string" ||
    !UUID.test(listing_id) ||
    typeof bars_sha256 !== "string" ||
    interval !== "1d" ||
    normalization !== "pct_return"
  ) {
    return null;
  }
  if (window === undefined) return { bar_range_id, listing_id, bars_sha256, window: null };
  if (
    !isRecord(window) ||
    window.kind !== "ytd" ||
    typeof window.year !== "number" ||
    typeof window.baseline_date !== "string" ||
    typeof window.end_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(window.end_date)
  ) {
    return null;
  }
  return {
    bar_range_id,
    listing_id,
    bars_sha256,
    window: { year: window.year, baseline_date: window.baseline_date, end_date: window.end_date },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
