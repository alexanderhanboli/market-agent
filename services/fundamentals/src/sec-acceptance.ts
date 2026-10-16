// SEC acceptance metadata (#199). The SEC says acceptance may precede first
// availability on sec.gov and is no guarantee of it, so acceptance is never
// publication proof: it is stored in sec_filing_acceptances, which nothing
// reads to decide eligibility at a cutoff.
//
// The feed's time zone is not established, so its values are kept raw and
// unparsed. EDGAR does not document it, and the two SEC surfaces disagree: for
// NVDA's filings (checked 2026-10-16), filings.recent.acceptanceDateTime read
// eight hours after the "Accepted" time on each filing's EDGAR index page
// (2026-08-27T00:36:00.000Z against 2026-08-26 16:36:00), neither the four or
// five hours a UTC reading of the feed implies nor the zero an Eastern one
// does. Conflicting timing stays unknown (#199).

import type { SecEdgarFetcher } from "./sec-edgar.ts";
import type { FundamentalsQueryExecutor } from "./sec-facts-repository.ts";
import type { UUID } from "./subject-ref.ts";

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
    await db.query(
      `insert into sec_filing_acceptances
         (source_id, accession, raw_value, parsed_at, timing_precision, source_timezone, evidence_ref, evidence_hash, conflicts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [filing.sourceId, filing.accessionNumber, rawValue, null, null, null,
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
