import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bootstrapDatabase, connectedPool, dockerAvailable, workspaceRoot } from "../../../db/test/docker-pg.ts";
import { backfillSecCompanionStatements, createSecBackedStatementRepository } from "../src/sec-facts-repository.ts";
import { secCompanyFetcher, secFetched } from "./fakes.ts";

const ISSUER_ID = "33000000-0000-4000-8000-000000000001";
const FALLBACK_SOURCE_ID = "33000000-0000-4000-8000-000000000003";
const FY2023_ACCESSION = "0000320193-24-000006";

function companyFacts(accession = FY2023_ACCESSION, revenue = "383285000000.123456789012345678") {
  const value = (val: string) => ({ start: "2023-01-01", end: "2023-12-31", val: Number(val), val_token: val, accn: accession, fy: 2023, fp: "FY", form: "10-K", filed: "2024-01-10" });
  return {
    cik: 320193,
    entityName: "Example Corp",
    facts: { "us-gaap": { Revenues: { label: "Revenues", description: "", units: { USD: [value(revenue)] } } } },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The deterministic source id ingestion derives from an accession. */
function accessionSourceId(accession: string): string {
  const hash = sha256(accession).slice(0, 32).split("");
  hash[12] = "4";
  hash[16] = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const utc = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const FY2023 = { issuer_id: ISSUER_ID, family: "income" as const, basis: "as_reported" as const, fiscal_year: 2023, fiscal_period: "FY" as const };

test("SEC ingestion binds source versions and their publication proofs", { timeout: 180_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for publication proof coverage");
    return;
  }
  const { databaseUrl } = await bootstrapDatabase(t, "fin-sec-publication");
  const db = await connectedPool(t, databaseUrl);
  await db.query(await readFile(join(workspaceRoot, "db", "seed", "metrics.sql"), "utf8"));
  await db.query(`insert into issuers (issuer_id, legal_name, cik) values ($1, 'Example Corp', '320193')`, [ISSUER_ID]);
  const repository = (completedAt: string, facts = companyFacts()) =>
    createSecBackedStatementRepository(db, {
      fetcher: secCompanyFetcher(() => facts, { completed_at: completedAt }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    });
  const proofsFor = async (sourceId: string) => (await db.query(
    `select source_version_hash, document_id, ${utc("available_not_before")} as available_not_before,
            ${utc("available_no_later_than")} as available_no_later_than, timing_precision, source_timezone,
            proof_method, proof_ref, proof_hash, mapping_version, supersedes
       from source_publication_attestations where source_id = $1 order by attested_at`,
    [sourceId],
  )).rows;
  // A backfill always downloads again: the re-ingest of a period already on file.
  const backfill = (completedAt: string, facts = companyFacts()) =>
    backfillSecCompanionStatements(db, {
      issuerId: ISSUER_ID,
      fetcher: secCompanyFetcher(() => facts, { completed_at: completedAt }),
      sourceId: FALLBACK_SOURCE_ID,
      logger: { warn: () => {} },
    });

  await t.test("a stored accession's version hash is never rewritten by a re-ingest", async () => {
    const otherIssuer = "33000000-0000-4000-8000-0000000000f1";
    const accession = "0000320199-24-000001";
    const sourceId = accessionSourceId(accession);
    await db.query(`insert into issuers (issuer_id, legal_name, cik) values ($1, 'Drifted Corp', '320199')`, [otherIssuer]);
    await db.query(
      `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at, content_hash)
       values ($1, 'sec_edgar', 'filing', 'primary', 'public', '2024-01-01T00:00:00Z', $2)`,
      [sourceId, "f".repeat(64)],
    );
    const drifted = { ...companyFacts(accession), cik: 320199 };
    await assert.rejects(
      () => repository("2024-02-01T10:05:00.000Z", drifted).find({ ...FY2023, issuer_id: otherIssuer }),
      /has another content_hash; a source version never changes/,
    );
    const row = (await db.query(`select content_hash, ${utc("retrieved_at")} as retrieved_at from sources where source_id = $1`, [sourceId])).rows[0];
    assert.deepEqual(row, { content_hash: "f".repeat(64), retrieved_at: "2024-01-01T00:00:00.000Z" });
    assert.equal((await db.query(`select count(*)::int as n from facts where subject_id = $1`, [otherIssuer])).rows[0].n, 0);
  });

  await t.test("a re-ingest refreshes retrieved_at and keeps the accession hash", async () => {
    const sourceId = accessionSourceId(FY2023_ACCESSION);
    await repository("2024-02-01T10:05:00.000Z").find(FY2023);
    await backfill("2024-03-01T09:00:00.000Z");
    const row = (await db.query(`select content_hash, ${utc("retrieved_at")} as retrieved_at from sources where source_id = $1`, [sourceId])).rows[0];
    assert.deepEqual(row, { content_hash: sha256(FY2023_ACCESSION), retrieved_at: "2024-03-01T09:00:00.000Z" });
  });

  await t.test("ingestion records one controlled-fetch proof per source version, at its first fetch's completion", async () => {
    const fy2023 = accessionSourceId(FY2023_ACCESSION);
    // The 10:05 lookup and the March backfill above both stored this version.
    assert.deepEqual(await proofsFor(fy2023), [{
      source_version_hash: sha256(FY2023_ACCESSION),
      document_id: null,
      available_not_before: null,
      available_no_later_than: "2024-02-01T10:05:00.000Z",
      timing_precision: "instant",
      source_timezone: "UTC",
      proof_method: "controlled_public_fetch",
      proof_ref: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
      proof_hash: secFetched(companyFacts()).body_sha256,
      mapping_version: "sec-companyfacts-controlled-fetch.v1",
      supersedes: null,
    }]);
    await backfill("2024-04-01T09:00:00.000Z");
    assert.equal((await proofsFor(fy2023)).length, 1, "a later fetch adds no proof");

    const amendment = "0000320193-24-000081";
    await backfill("2024-05-01T12:00:00.000Z", companyFacts(amendment, "383300000000"));
    assert.deepEqual(
      (await proofsFor(accessionSourceId(amendment))).map((proof) => [proof.source_version_hash, proof.available_no_later_than]),
      [[sha256(amendment), "2024-05-01T12:00:00.000Z"]],
      "a new accession gets its own proof",
    );
    assert.equal((await proofsFor(fy2023)).length, 1);
  });
});
