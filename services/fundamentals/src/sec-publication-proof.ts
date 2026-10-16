// Publication proof for SEC filing sources (#199). A controlled public fetch
// proves only that the bytes it fetched were public when the fetch completed:
// the proof is that instant, never the filing date and never SEC acceptance
// (acceptance can precede availability on sec.gov; see sec-acceptance.ts).
// Historical cutoffs before the first fetch need an archive proof, which this
// producer does not make.

import { createHash } from "node:crypto";
import { recordSourcePublicationAttestation } from "../../evidence/src/financial-attestations.ts";
import type { SecFetchEvidence } from "./sec-edgar.ts";
import type { FundamentalsQueryExecutor } from "./sec-facts-repository.ts";
import type { UUID } from "./subject-ref.ts";

export const SEC_FETCH_PROOF_MAPPING_VERSION = "sec-companyfacts-controlled-fetch.v1";

/** An accession is immutable (an amendment is a new accession), so it is the source version. */
export function secAccessionVersionHash(accessionNumber: string): string {
  return createHash("sha256").update(accessionNumber).digest("hex");
}

/**
 * Records that the accession's source version was public by the fetch's
 * completion, unless an earlier instant proof of that version already says
 * so. Run inside the transaction that stores the fetch's facts.
 */
export async function recordSecFetchPublication(
  db: FundamentalsQueryExecutor,
  input: { sourceId: UUID; accessionNumber: string; evidence: SecFetchEvidence },
): Promise<void> {
  const version = secAccessionVersionHash(input.accessionNumber);
  // Serializes concurrent ingests of one accession, so the check below sees a
  // proof another one just committed.
  await db.query(`select source_id from sources where source_id = $1 for update`, [input.sourceId]);
  // A date proof's bound spans its source-local day, so only an instant proof
  // is known to be no later than this fetch.
  const earlier = await db.query(
    `select attestation_id from current_source_publication_attestations
      where source_id = $1 and source_version_hash = $2 and document_id is null
        and timing_precision <> 'date' and available_no_later_than <= $3::timestamptz
      limit 1`,
    [input.sourceId, version, input.evidence.completed_at],
  );
  if (earlier.rows.length > 0) return;
  await recordSourcePublicationAttestation(db, {
    source_id: input.sourceId,
    document_id: null,
    source_version_hash: version,
    available_not_before: null,
    available_no_later_than: input.evidence.completed_at,
    timing_precision: "instant",
    source_timezone: "UTC",
    proof_method: "controlled_public_fetch",
    proof_ref: input.evidence.url,
    proof_hash: input.evidence.body_sha256,
    mapping_version: SEC_FETCH_PROOF_MAPPING_VERSION,
  });
}
