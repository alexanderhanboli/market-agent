// SEC acceptance metadata (#199). The SEC says acceptance may precede first
// availability on sec.gov and is no guarantee of it, so acceptance is never
// publication proof: it is stored in sec_filing_acceptances, which nothing
// reads to decide eligibility at a cutoff.
//
// Format rule. The submissions feed (filings.recent.acceptanceDateTime) gives
// values like "2024-11-01T18:04:43.000Z". The digits are EDGAR's acceptance
// wall clock in Eastern time (America/New_York); the trailing "Z" is not a UTC
// designator. A bare "YYYY-MM-DD" is date precision, recorded as the end of
// that Eastern day. Anything else is malformed, and so is an Eastern wall
// clock that does not exist or occurs twice (a DST change): parsed_at stays
// null and the raw value is kept as given.

import { endOfLocalDay } from "../../financial-core/src/public-time.ts";
import type { SecEdgarFetcher } from "./sec-edgar.ts";
import type { FundamentalsQueryExecutor } from "./sec-facts-repository.ts";
import type { UUID } from "./subject-ref.ts";

export const SEC_ACCEPTANCE_TIMEZONE = "America/New_York";

export type ParsedSecAcceptance = Readonly<
  | { parsed_at: string; timing_precision: "instant" | "date" }
  | { parsed_at: null; timing_precision: null }
>;

const UNKNOWN: ParsedSecAcceptance = { parsed_at: null, timing_precision: null };
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const HOUR_MS = 3_600_000;

export function parseSecAcceptance(raw: string): ParsedSecAcceptance {
  const date = DATE.exec(raw);
  if (date) {
    return validWallClock(date.slice(1, 4).map(Number), [0, 0, 0, 0])
      ? { parsed_at: endOfLocalDay(raw, SEC_ACCEPTANCE_TIMEZONE), timing_precision: "date" }
      : UNKNOWN;
  }
  const instant = INSTANT.exec(raw);
  if (!instant) return UNKNOWN;
  const [year, month, day, hour, minute, second] = instant.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number(instant[7] ?? "0");
  if (!validWallClock([year, month, day], [hour, minute, second, ms])) return UNKNOWN;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Eastern is UTC-4 (EDT) or UTC-5 (EST): the wall clock is exactly one of
  // those instants unless it falls in a DST gap or overlap.
  const matches = [4, 5].map((hours) => wall + hours * HOUR_MS).filter((candidate) => easternWallClock(candidate) === wall);
  return matches.length === 1 ? { parsed_at: new Date(matches[0]!).toISOString(), timing_precision: "instant" } : UNKNOWN;
}

function validWallClock([year, month, day]: number[], [hour, minute, second]: number[]): boolean {
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
    && hour! < 24 && minute! < 60 && second! < 60;
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: SEC_ACCEPTANCE_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The Eastern wall clock at `instant`, as if it were a UTC timestamp. */
function easternWallClock(instant: number): number {
  const parts = Object.fromEntries(EASTERN.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!, instant % 1000);
}

export function submissionsPath(cik: number): string {
  return `/submissions/CIK${String(cik).padStart(10, "0")}.json`;
}

export type SecFilingRef = Readonly<{ sourceId: UUID; accessionNumber: string }>;

/**
 * Fetches the issuer's submissions once and records the acceptance value of
 * each filing ingestion stored. Acceptance is metadata only: a failed fetch
 * or an unreadable feed is logged and records nothing.
 */
export async function recordSecFilingAcceptances(
  db: FundamentalsQueryExecutor,
  fetcher: SecEdgarFetcher,
  input: { cik: number; filings: ReadonlyArray<SecFilingRef>; logger: Pick<Console, "warn"> },
): Promise<void> {
  if (input.filings.length === 0) return;
  let fetched;
  try {
    fetched = await fetcher(submissionsPath(input.cik));
  } catch (error) {
    input.logger.warn("sec_edgar acceptance metadata fetch failed", { cik: input.cik, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const recent = recentAcceptances(fetched.json);
  if (recent === null) {
    input.logger.warn("sec_edgar acceptance metadata unreadable", { cik: input.cik, url: fetched.url });
    return;
  }
  for (const filing of new Map(input.filings.map((entry) => [entry.accessionNumber, entry])).values()) {
    const values = [...new Set(recent.flatMap((entry) => (entry.accession === filing.accessionNumber ? [entry.raw] : [])))];
    if (values.length === 0) continue;
    const prior = (await db.query<{ raw_value: string; conflicts: string[] }>(
      `select raw_value, conflicts from sec_filing_acceptances where accession = $1 order by recorded_at desc, acceptance_id`,
      [filing.accessionNumber],
    )).rows;
    const rawValue = values[0]!;
    const seen = new Set([...values, ...prior.flatMap((row) => [row.raw_value, ...row.conflicts])]);
    seen.delete(rawValue);
    const conflicts = [...seen].sort();
    const latest = prior[0];
    if (latest && latest.raw_value === rawValue && [...latest.conflicts].sort().join("\n") === conflicts.join("\n")) continue;
    const parsed = conflicts.length > 0 ? UNKNOWN : parseSecAcceptance(rawValue);
    await db.query(
      `insert into sec_filing_acceptances
         (source_id, accession, raw_value, parsed_at, timing_precision, source_timezone, evidence_ref, evidence_hash, conflicts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [filing.sourceId, filing.accessionNumber, rawValue, parsed.parsed_at, parsed.timing_precision, SEC_ACCEPTANCE_TIMEZONE,
        fetched.url, fetched.body_sha256, JSON.stringify(conflicts)],
    );
  }
}

/** The feed's (accession, acceptance) pairs, the raw value kept as given; null when the arrays are missing. */
function recentAcceptances(json: unknown): Array<{ accession: string; raw: string }> | null {
  const recent = (json as { filings?: { recent?: { accessionNumber?: unknown; acceptanceDateTime?: unknown } } } | null)?.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber) || !Array.isArray(recent.acceptanceDateTime)) return null;
  const acceptances = recent.acceptanceDateTime as unknown[];
  return (recent.accessionNumber as unknown[]).flatMap((accession, index) =>
    typeof accession === "string" && index < acceptances.length
      ? [{ accession, raw: typeof acceptances[index] === "string" ? (acceptances[index] as string) : JSON.stringify(acceptances[index]) ?? "null" }]
      : [],
  );
}
