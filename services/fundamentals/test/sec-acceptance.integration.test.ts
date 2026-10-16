import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bootstrapDatabase, connectedPool, dockerAvailable, workspaceRoot } from "../../../db/test/docker-pg.ts";
import { recordFactPrecisionAttestation } from "../../evidence/src/financial-attestations.ts";
import { recordFactFinancialContext } from "../../evidence/src/financial-context.ts";
import { recordSecFilingAcceptances } from "../src/sec-acceptance.ts";
import { recordSecFetchPublication } from "../src/sec-publication-proof.ts";
import { SecEdgarFetchError } from "../src/sec-edgar.ts";
import { backfillSecCompanionStatements, createSecBackedStatementRepository } from "../src/sec-facts-repository.ts";
import { secCompanyFetcher, secFetched } from "./fakes.ts";
import { originalContext, selectRevenue } from "./financial-selection.ts";

const FALLBACK_SOURCE_ID = "34000000-0000-4000-8000-000000000003";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0000320193.json";

function companyFacts(cik: number, accession: string) {
  const value = { start: "2023-01-01", end: "2023-12-31", val: 1000, val_token: "1000", accn: accession, fy: 2023, fp: "FY", form: "10-K", filed: "2024-01-10" };
  return { cik, entityName: "Example Corp", facts: { "us-gaap": { Revenues: { label: "Revenues", description: "", units: { USD: [value] } } } } };
}

function submissions(entries: Array<[string, unknown]>) {
  return { filings: { recent: { accessionNumber: entries.map(([accession]) => accession), acceptanceDateTime: entries.map(([, value]) => value) } } };
}

const utc = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

test("SEC acceptance metadata is recorded apart from publication proof", { timeout: 180_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for acceptance metadata coverage");
    return;
  }
  const { databaseUrl } = await bootstrapDatabase(t, "fin-sec-acceptance");
  const db = await connectedPool(t, databaseUrl);
  await db.query(await readFile(join(workspaceRoot, "db", "seed", "metrics.sql"), "utf8"));
  let issuerCount = 0;
  const newIssuer = async (cik: number) => {
    issuerCount += 1;
    const issuerId = `34000000-0000-4000-8000-${String(issuerCount).padStart(12, "0")}`;
    await db.query(`insert into issuers (issuer_id, legal_name, cik) values ($1, 'Example Corp', $2)`, [issuerId, String(cik)]);
    return issuerId;
  };
  const lookup = (issuerId: string) => ({ issuer_id: issuerId, family: "income" as const, basis: "as_reported" as const, fiscal_year: 2023, fiscal_period: "FY" as const });
  const acceptances = async (accession: string) => (await db.query(
    `select raw_value, ${utc("parsed_at")} as parsed_at, timing_precision, source_timezone, evidence_ref, evidence_hash, conflicts
       from sec_filing_acceptances where accession = $1 order by recorded_at, acceptance_id`,
    [accession],
  )).rows;

  await t.test("an ingest records its filing's acceptance once, with its evidence; a later different value is a conflict", async () => {
    const accession = "0000320193-24-000006";
    const issuerId = await newIssuer(320193);
    const feed = submissions([["0000320193-24-000001", "2024-01-02T08:00:00.000Z"], [accession, "2024-01-10T16:30:05.000Z"]]);
    await createSecBackedStatementRepository(db, {
      fetcher: secCompanyFetcher(() => companyFacts(320193, accession), { submissions: feed }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => assert.fail("nothing to warn about") },
    }).find(lookup(issuerId));
    const recorded = {
      raw_value: "2024-01-10T16:30:05.000Z",
      // Kept raw: the feed's time zone is not established (sec-acceptance.ts).
      parsed_at: null,
      timing_precision: null,
      source_timezone: null,
      evidence_ref: SUBMISSIONS_URL,
      evidence_hash: secFetched(feed).body_sha256,
      conflicts: [],
    };
    assert.deepEqual(await acceptances(accession), [recorded]);
    assert.deepEqual(await acceptances("0000320193-24-000001"), [], "only filings ingestion stored are recorded");

    const backfill = (json: unknown) => backfillSecCompanionStatements(db, {
      issuerId,
      fetcher: secCompanyFetcher(() => companyFacts(320193, accession), { submissions: json }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    });
    await backfill(feed);
    assert.equal((await acceptances(accession)).length, 1, "the same value is not recorded twice");

    const revised = submissions([[accession, "2024-01-10T16:31:00.000Z"]]);
    await backfill(revised);
    assert.deepEqual((await acceptances(accession))[1], {
      ...recorded,
      raw_value: "2024-01-10T16:31:00.000Z",
      evidence_hash: secFetched(revised).body_sha256,
      conflicts: ["2024-01-10T16:30:05.000Z"],
    });
    await backfill(revised);
    assert.equal((await acceptances(accession)).length, 2);
  });

  await t.test("a feed that lists one accession with two values, or a malformed one, records it unknown", async () => {
    const twice = "0000320194-24-000001";
    const issuerA = await newIssuer(320194);
    await createSecBackedStatementRepository(db, {
      fetcher: secCompanyFetcher(() => companyFacts(320194, twice), { submissions: submissions([[twice, "2024-01-10T16:30:05.000Z"], [twice, "2024-01-11T09:00:00.000Z"]]) }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    }).find(lookup(issuerA));
    assert.deepEqual((await acceptances(twice)).map((row) => [row.raw_value, row.parsed_at, row.conflicts]), [
      ["2024-01-10T16:30:05.000Z", null, ["2024-01-11T09:00:00.000Z"]],
    ]);

    const malformed = "0000320195-24-000001";
    const issuerB = await newIssuer(320195);
    await createSecBackedStatementRepository(db, {
      fetcher: secCompanyFetcher(() => companyFacts(320195, malformed), { submissions: submissions([[malformed, "Jan 10 2024 4:30pm"]]) }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    }).find(lookup(issuerB));
    assert.deepEqual((await acceptances(malformed)).map((row) => [row.raw_value, row.parsed_at, row.timing_precision, row.conflicts]), [
      ["Jan 10 2024 4:30pm", null, null, []],
    ]);
  });

  await t.test("concurrent recorders of one filing record a value once, and a differing one as a conflict (#320 review)", async () => {
    const record = async (accession: string, sourceId: string, raw: string) =>
      recordSecFilingAcceptances(db, secCompanyFetcher(() => ({}), { submissions: submissions([[accession, raw]]) }), {
        cik: 320198,
        filings: [{ sourceId, accessionNumber: accession }],
        logger: { warn: () => {} },
      });
    const newSource = async (sourceId: string, accession: string) => db.query(
      `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at, content_hash)
       values ($1, 'sec_edgar', 'filing', 'primary', 'public', now(), $2)`,
      [sourceId, createHash("sha256").update(accession).digest("hex")],
    );
    const same = "0000320198-24-000001";
    await newSource("34000000-0000-4000-8000-0000000000e1", same);
    await Promise.all(Array.from({ length: 4 }, () => record(same, "34000000-0000-4000-8000-0000000000e1", "2024-01-10T16:30:05.000Z")));
    assert.equal((await acceptances(same)).length, 1, "one value, recorded once");

    const differing = "0000320198-24-000002";
    await newSource("34000000-0000-4000-8000-0000000000e2", differing);
    await Promise.all([
      record(differing, "34000000-0000-4000-8000-0000000000e2", "2024-01-10T16:30:05.000Z"),
      record(differing, "34000000-0000-4000-8000-0000000000e2", "2024-01-10T16:31:00.000Z"),
    ]);
    const rows = await acceptances(differing);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1]!.conflicts, [rows[0]!.raw_value], "the later row records the earlier value as a conflict");
  });

  await t.test("a failed submissions fetch is logged and the ingest still stores its facts", async () => {
    const accession = "0000320196-24-000001";
    const issuerId = await newIssuer(320196);
    const companyFactsFetcher = secCompanyFetcher(() => companyFacts(320196, accession));
    const warnings: unknown[][] = [];
    const statement = await createSecBackedStatementRepository(db, {
      fetcher: async (path) => {
        if (path.startsWith("/submissions/")) throw new SecEdgarFetchError(503, "sec_edgar: HTTP 503");
        return companyFactsFetcher(path);
      },
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    }).find(lookup(issuerId));
    assert.equal(statement?.lines.find((line) => line.metric_key === "revenue")?.value_num, 1000);
    assert.deepEqual(warnings, [["sec_edgar acceptance metadata fetch failed", { cik: 320196, error: "sec_edgar: HTTP 503" }]]);
    assert.deepEqual(await acceptances(accession), []);
  });

  await t.test("acceptance alone never makes a precise, contextual fact eligible, even before the cutoff", async () => {
    const accession = "0000320197-24-000001";
    const issuerId = await newIssuer(320197);
    const sourceId = "34000000-0000-4000-8000-0000000000c1";
    const factId = "34000000-0000-4000-8000-0000000000d1";
    await db.query(
      `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at, content_hash)
       values ($1, 'sec_edgar', 'filing', 'primary', 'public', '2024-02-01T15:05:00Z', $2)`,
      [sourceId, createHash("sha256").update(accession).digest("hex")],
    );
    await db.query(
      `insert into facts (fact_id, subject_kind, subject_id, metric_id, period_kind, period_start, period_end, fiscal_year, fiscal_period,
                          value_num, unit, currency, scale, as_of, observed_at, source_id, method, verification_status, freshness_class, coverage_level, confidence)
       select $1, 'issuer', $2, metric_id, 'fiscal_y', '2023-01-01', '2023-12-31', 2023, 'FY', 1000, 'currency', 'USD', 1,
              '2024-01-11T00:00:00Z', '2024-01-11T00:00:00Z', $3, 'reported', 'authoritative', 'filing_time', 'full', 1
         from metrics where metric_key = 'revenue'`,
      [factId, issuerId, sourceId],
    );
    await recordFactPrecisionAttestation(db, { fact_id: factId, precision_class: "source_token_preserved", raw_token: "1000", token_proof_hash: "e".repeat(64), source_locator: null, validation_method: "fixture" });
    await recordFactFinancialContext(db, originalContext(factId));
    // A parsed acceptance well before the cutoff, as a future parser could record it.
    await db.query(
      `insert into sec_filing_acceptances (source_id, accession, raw_value, parsed_at, timing_precision, source_timezone, evidence_ref, evidence_hash)
       values ($1, $2, '2024-01-10T16:30:05.000Z', '2024-01-10T21:30:05Z', 'instant', 'UTC', $3, $4)`,
      [sourceId, accession, SUBMISSIONS_URL, "f".repeat(64)],
    );
    assert.equal((await acceptances(accession))[0]?.parsed_at, "2024-01-10T21:30:05.000Z");

    const cutoff = "2024-01-15T23:59:59.999-05:00";
    assert.deepEqual(await selectRevenue(db, issuerId, cutoff), { status: "gap", reason_code: "publication_time_unknown" });

    // The same fact with a genuine proof before the cutoff is eligible.
    await recordSecFetchPublication(db, {
      sourceId,
      accessionNumber: accession,
      evidence: { url: "https://data.sec.gov/fixture", body_sha256: "b".repeat(64), completed_at: "2024-01-12T15:00:00.000Z" },
    });
    const selected = await selectRevenue(db, issuerId, cutoff);
    assert.equal(selected.status, "selected");
    assert.deepEqual(selected.status === "selected" && [selected.input.candidate.fact_id, selected.input.publication.available_no_later_than], [factId, "2024-01-12T15:00:00.000Z"]);
  });
});
