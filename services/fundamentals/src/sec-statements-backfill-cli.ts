// Backfill SEC cash flow and balance sheet facts for income periods already
// on file (backfillSecCompanionStatements).
//
//   DATABASE_URL=... SEC_EDGAR_USER_AGENT=... \
//     npm run backfill:sec-statements [-- <issuer_uuid> ...]
//
// With no arguments, backfills every issuer that has SEC income facts. One
// companyfacts download per issuer, one at a time, within SEC's fair-access
// rate. A rerun is safe: facts already stored are left as they are.

import { Pool } from "pg";

import { SEC_EDGAR_FILING_SOURCE_ID } from "./provider-sources.ts";
import { createSecCompanyFactsHttpFetcher } from "./sec-edgar-http.ts";
import { backfillSecCompanionStatements } from "./sec-facts-repository.ts";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const userAgent = process.env.SEC_EDGAR_USER_AGENT;
  if (!databaseUrl || !userAgent) throw new Error("DATABASE_URL and SEC_EDGAR_USER_AGENT are required");
  const pool = new Pool({ connectionString: databaseUrl });
  const fetcher = createSecCompanyFactsHttpFetcher({ userAgent, baseUrl: process.env.SEC_EDGAR_BASE_URL });
  const requestedIds = process.argv.slice(2);
  let hadFailures = false;
  try {
    const issuers = requestedIds.length
      ? await pool.query<{ issuer_id: string; legal_name: string }>(
          `select issuer_id::text as issuer_id, legal_name from issuers where issuer_id = any($1::uuid[])`,
          [requestedIds],
        )
      : await pool.query<{ issuer_id: string; legal_name: string }>(
          `select i.issuer_id::text as issuer_id, i.legal_name
             from issuers i
            where i.cik is not null
              and exists (
                select 1 from facts f join sources s on s.source_id = f.source_id
                 where f.subject_kind = 'issuer' and f.subject_id = i.issuer_id and s.provider = 'sec_edgar'
              )
            order by i.legal_name`,
        );
    for (const issuer of issuers.rows) {
      try {
        const { periods } = await backfillSecCompanionStatements(pool, {
          issuerId: issuer.issuer_id,
          fetcher,
          sourceId: SEC_EDGAR_FILING_SOURCE_ID,
        });
        console.log(`${issuer.legal_name}: cash flow and balance sheet checked for ${periods} period(s)`);
      } catch (error) {
        hadFailures = true;
        console.error(`${issuer.legal_name}: backfill failed —`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    await pool.end();
  }
  // Per-issuer failures are logged and the loop continues, but automation must
  // still see a non-zero exit when any issuer failed.
  if (hadFailures) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
