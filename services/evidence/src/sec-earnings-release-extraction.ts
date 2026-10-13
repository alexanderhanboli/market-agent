// Management's own explanations and guidance from earnings releases (#205: the
// analyst could only say "the data does not show why"). An 8-K Item 2.02
// ("Results of Operations") files the earnings release and CFO commentary as
// EX-99 exhibits. A model picks the sentences in which management explains a
// result ("...a $4.5 billion charge associated with H20 excess inventory") or
// gives guidance, and each one is kept only if it is a verbatim quote of the
// exhibit text: the stored claim is the document's own words, never the model's.
//
// A batch step like 8-K enrichment (sec-8k-enrichment.ts), never the atomic
// crawl: candidates are Item 2.02 claims (material_event.guidance_update) not
// yet processed, and enriched_at marks them processed. (High-severity
// enrichment reads other predicates, so the two never share a claim.)
//
// Each verified quote becomes a claim:
// - predicate management.explanation.<metric> or guidance.<metric>, metric from
//   a closed list;
// - text the exhibit's own sentence, modality "quoted", attributed to the
//   issuer, dated by the filing;
// - a claim_evidence row locating it (exhibit, character span, quote hash).
// Chat reads these as management attributions: the only causes an answer may
// state (llm-runtime.ts).

import { createHash } from "node:crypto";

import type { LlmChatMessage, LlmChatRequest, LlmRouterResult } from "../../llm/src/router.ts";
import { writeToolCallLog } from "../../observability/src/tool-call.ts";
import { createClaimArgument } from "./claim-argument-repo.ts";
import { createClaimEvidence } from "./claim-evidence-repo.ts";
import { createClaim } from "./claim-repo.ts";
import type { SecFilingFetcher } from "./sec-edgar.ts";
import { withTransaction } from "./transaction.ts";
import type { QueryExecutor } from "./types.ts";

export const RELEASE_STATEMENT_KINDS = ["explanation", "guidance"] as const;
export type ReleaseStatementKind = (typeof RELEASE_STATEMENT_KINDS)[number];

// What a statement is about. "other" keeps a real explanation whose subject
// is none of these (a segment, a product line).
export const RELEASE_METRICS = [
  "revenue",
  "gross_margin",
  "operating_expenses",
  "operating_income",
  "net_income",
  "eps",
  "operating_cash_flow",
  "free_cash_flow",
  "capex",
  "other",
] as const;
export type ReleaseMetric = (typeof RELEASE_METRICS)[number];

// The claim's confidence: the words are verified, their reading as an
// explanation or guidance is the model's (as for enriched 8-K narratives).
const RELEASE_CONFIDENCE = 0.8;
const MAX_STATEMENTS = 8;
const MIN_QUOTE_CHARS = 20;
const MAX_QUOTE_CHARS = 600;
// The release and the CFO commentary together run to ~40k characters.
const MAX_PROMPT_CHARS = 60_000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type ExtractReleaseLlm = { complete(request: LlmChatRequest): Promise<LlmRouterResult> };

export type ExtractReleaseDeps = {
  db: QueryExecutor;
  llm: ExtractReleaseLlm;
  secClient: SecFilingFetcher;
};

export type ReleaseCandidate = {
  claimId: string;
  accession: string;
  issuerCik: number;
  issuerId: string;
  documentId: string;
  sourceId: string;
  effectiveTime: string | null;
};

// An exhibit's text, and where its HTML blocks (paragraphs, list items, table
// cells, headings) start and end in it: a heading has no full stop, so a block
// edge is a sentence edge too.
export type ReleaseExhibit = { type: string; text: string; edges: ReadonlySet<number> };
export type ReleaseStatement = { kind: ReleaseStatementKind; metric: ReleaseMetric; quote: string };
export type VerifiedStatement = ReleaseStatement & { exhibit: string; start: number; end: number };

// "extracted": at least one verified statement stored. "noop": a concurrent
// run already processed the claim.
export type ExtractReleaseOutcome = "extracted" | "empty" | "unparseable" | "no_exhibits" | "noop";

// Item 2.02 claims not yet processed, with what is needed to fetch the filing.
export async function findReleaseCandidates(
  db: QueryExecutor,
  opts: { afterClaimId?: string; limit?: number } = {},
): Promise<ReleaseCandidate[]> {
  const { rows } = await db.query<{
    claim_id: string;
    accession: string;
    cik: string;
    issuer_id: string;
    document_id: string;
    source_id: string;
    effective_time: Date | string | null;
  }>(
    `select distinct on (c.claim_id)
            c.claim_id::text as claim_id,
            d.provider_doc_id as accession,
            i.cik,
            ca.subject_id::text as issuer_id,
            c.document_id::text as document_id,
            c.reported_by_source_id::text as source_id,
            c.effective_time
       from claims c
       join claim_arguments ca on ca.claim_id = c.claim_id and ca.subject_kind = 'issuer'
       join documents d on d.document_id = c.document_id
       join issuers i on i.issuer_id = ca.subject_id
      where c.predicate = 'material_event.guidance_update'
        and c.enriched_at is null
        and i.cik is not null
        and c.claim_id > $1::uuid
      order by c.claim_id
      limit $2`,
    [opts.afterClaimId ?? ZERO_UUID, opts.limit ?? 100],
  );
  return rows.flatMap((row) => {
    const issuerCik = Number(row.cik);
    if (!Number.isInteger(issuerCik) || issuerCik <= 0) return [];
    return [{
      claimId: row.claim_id,
      accession: row.accession,
      issuerCik,
      issuerId: row.issuer_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      effectiveTime: row.effective_time == null ? null : new Date(row.effective_time).toISOString(),
    }];
  });
}

// The EX-99 exhibits of a full EDGAR submission (.txt), each as plain text.
export function releaseExhibits(submission: string): ReleaseExhibit[] {
  const exhibits: ReleaseExhibit[] = [];
  for (const [, document] of submission.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
    const type = /<TYPE>([^\n<]+)/.exec(document!)?.[1]?.trim() ?? "";
    if (!/^EX-99(?:\.\d+)?$/i.test(type)) continue;
    const body = /<TEXT>([\s\S]*)<\/TEXT>/.exec(document!)?.[1] ?? "";
    const blocks = body.split(BLOCK_BREAK).map(canonicalText).filter((block) => block !== "");
    const edges = new Set<number>();
    let at = 0;
    for (const block of blocks) {
      edges.add(at);
      at += block.length;
      edges.add(at);
      at += 1; // the space joining blocks
    }
    const text = blocks.join(" ");
    if (text !== "") exhibits.push({ type: type.toUpperCase(), text, edges });
  }
  return exhibits;
}

const BLOCK_BREAK = /<(?:\/(?:div|p|li|tr|td|th|h[1-6]|table|ul|ol)|br\s*\/?)\s*>/i;

// Exhibit HTML (or text) as comparable text: tags dropped, entities decoded,
// typographic quotes and dashes made plain, whitespace collapsed. Quotes are
// matched in this form, and stored from it.
export function canonicalText(markup: string): string {
  return plainPunctuation(decodeEntities(
    markup
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )).replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function plainPunctuation(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ");
}

// The model's statements, or null when the reply is not the expected shape.
export function parseReleaseStatements(text: string): ReleaseStatement[] | null {
  let reply: unknown;
  try {
    reply = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  const items = (reply as { statements?: unknown } | null)?.statements;
  if (!Array.isArray(items)) return null;
  const statements: ReleaseStatement[] = [];
  for (const item of items.slice(0, MAX_STATEMENTS)) {
    const { kind, metric, quote } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof quote !== "string" ||
      !(RELEASE_STATEMENT_KINDS as ReadonlyArray<unknown>).includes(kind) ||
      !(RELEASE_METRICS as ReadonlyArray<unknown>).includes(metric)
    ) {
      continue;
    }
    statements.push({ kind: kind as ReleaseStatementKind, metric: metric as ReleaseMetric, quote });
  }
  return statements;
}

// A statement whose quote is in an exhibit, verbatim (in canonical form) and
// as whole sentences, with where it is; null for a quote the exhibits do not
// hold, a clause cut from a sentence ("decline due to weaker demand" out of
// "Revenue did not decline due to weaker demand"), or one too short or long.
// The stored text is the exhibit's, not the model's.
export function verifyStatement(statement: ReleaseStatement, exhibits: ReadonlyArray<ReleaseExhibit>): VerifiedStatement | null {
  const quote = canonicalText(statement.quote);
  if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) return null;
  for (const exhibit of exhibits) {
    for (let start = exhibit.text.indexOf(quote); start >= 0; start = exhibit.text.indexOf(quote, start + 1)) {
      const end = start + quote.length;
      if (startsSentence(exhibit, start) && endsSentence(exhibit, end)) {
        return { ...statement, quote: exhibit.text.slice(start, end), exhibit: exhibit.type, start, end };
      }
    }
  }
  return null;
}

// A sentence starts where a block starts, or after a sentence's end (a full
// stop, question or exclamation mark, colon, semicolon or bullet).
function startsSentence(exhibit: ReleaseExhibit, start: number): boolean {
  return exhibit.edges.has(start) || /[.!?:;•]["')]?\s$/.test(exhibit.text.slice(Math.max(0, start - 3), start));
}

// A sentence ends where a block ends, or with its own end mark (and a closing
// quote or bracket), before a space or the end of the text.
function endsSentence(exhibit: ReleaseExhibit, end: number): boolean {
  if (exhibit.edges.has(end)) return true;
  const next = exhibit.text[end];
  return /[.!?]["')]?$/.test(exhibit.text.slice(Math.max(0, end - 2), end)) && (next === undefined || next === " ");
}

function buildMessages(exhibits: ReadonlyArray<ReleaseExhibit>): LlmChatMessage[] {
  const text = exhibits.map((exhibit) => `[${exhibit.type}]\n${exhibit.text}`).join("\n\n").slice(0, MAX_PROMPT_CHARS);
  return [
    {
      role: "system",
      content: [
        "You read a company's earnings release and CFO commentary from an SEC 8-K, and pick the sentences in which",
        "management (1) explains why a reported result changed, or (2) gives guidance for a coming period.",
        'Reply with minified JSON only: {"statements":[{"kind":"explanation"|"guidance","metric":"<metric>","quote":"<sentence>"}]}',
        `metric is one of: ${RELEASE_METRICS.join(", ")} (other when the subject is none of these).`,
        "quote is copied EXACTLY from the text, character for character: one or two whole sentences, no paraphrase,",
        "no ellipsis, nothing added. A quote that is not in the text is discarded.",
        "An explanation names a cause (a charge, a product, a mix shift, pricing, a ramp), not just the figure.",
        "Skip boilerplate: forward-looking-statement disclaimers, non-GAAP definitions, table rows.",
        `At most ${MAX_STATEMENTS} statements, the most informative first. If there are none, reply {"statements":[]}.`,
      ].join("\n"),
    },
    { role: "user", content: text },
  ];
}

// Extract one candidate's statements and store the verified ones. Transport
// errors propagate, so a drain fails-and-retries the item later. The stored
// claims, the enriched_at stamp and the audit row are one transaction, and the
// stamp is rowCount-guarded: a concurrent run makes this one a "noop".
export async function extractReleaseStatements(
  deps: ExtractReleaseDeps,
  candidate: ReleaseCandidate,
): Promise<ExtractReleaseOutcome> {
  const fetched = await deps.secClient.fetchFiling({
    cik: candidate.issuerCik,
    accession_number: candidate.accession,
    document: `${candidate.accession}.txt`,
  });
  const exhibits = releaseExhibits(new TextDecoder("utf-8").decode(fetched.bytes));
  let model: string | null = null;
  let parsed: ReleaseStatement[] | null = [];
  if (exhibits.length > 0) {
    // Low reasoning: it picks sentences, and the quote check does the rest. A
    // large model's default reasoning took 4 minutes on one release in a probe.
    const completion = await deps.llm.complete({ messages: buildMessages(exhibits), temperature: 0, maxTokens: 3_000, reasoning: "low" });
    model = completion.deployment.model;
    parsed = parseReleaseStatements(completion.text);
  }
  const verified = (parsed ?? []).flatMap((statement) => verifyStatement(statement, exhibits) ?? []);
  const outcome: ExtractReleaseOutcome = exhibits.length === 0
    ? "no_exhibits"
    : parsed === null
    ? "unparseable"
    : verified.length === 0
    ? "empty"
    : "extracted";

  let applied = false;
  await withTransaction(deps.db, async (tx) => {
    const stamped = await tx.db.query(
      `update claims set enriched_at = now() where claim_id = $1 and enriched_at is null`,
      [candidate.claimId],
    );
    if ((stamped.rowCount ?? 0) === 0) return;
    applied = true;
    const claimIds: string[] = [];
    for (const statement of verified) {
      const claim = await createClaim(tx.db, {
        document_id: candidate.documentId,
        predicate: `${statement.kind === "explanation" ? "management.explanation" : "guidance"}.${statement.metric}`,
        text_canonical: statement.quote,
        polarity: "neutral",
        modality: "quoted",
        reported_by_source_id: candidate.sourceId,
        attributed_to_type: "issuer",
        attributed_to_id: candidate.issuerId,
        effective_time: candidate.effectiveTime,
        confidence: RELEASE_CONFIDENCE,
        status: "extracted",
      });
      await createClaimArgument(tx.db, { claim_id: claim.claim_id, subject_kind: "issuer", subject_id: candidate.issuerId, role: "subject" });
      await createClaimEvidence(tx.db, {
        claim_id: claim.claim_id,
        document_id: candidate.documentId,
        locator: { exhibit: statement.exhibit, start: statement.start, end: statement.end, text_basis: "sec_exhibit_canonical_text.v1" },
        excerpt_hash: createHash("sha256").update(statement.quote).digest("hex"),
        confidence: 1,
      });
      claimIds.push(claim.claim_id);
    }
    // An audit row, as for 8-K enrichment: tool_call_logs stores digests of
    // args and result, so it records that the call ran, not what it said.
    await writeToolCallLog(tx.db, {
      tool_name: "extract_earnings_release",
      args: { claim_id: candidate.claimId, accession: candidate.accession, model },
      result: {
        outcome,
        exhibits: exhibits.map((exhibit) => exhibit.type),
        proposed: parsed?.length ?? 0,
        verified: verified.length,
        claim_ids: claimIds,
      },
      status: outcome === "extracted" ? "ok" : outcome === "unparseable" ? "partial" : "skipped",
    });
  });
  return applied ? outcome : "noop";
}

export type ExtractReleaseDrainResult = Record<ExtractReleaseOutcome | "failed", number>;

// Drain the backlog by a claim_id keyset, advancing past failures so one bad
// filing never blocks the rest; a failed claim stays a candidate for next time.
export async function runReleaseExtractionDrain(
  deps: ExtractReleaseDeps,
  opts: { pageSize?: number; onClaim?: (candidate: ReleaseCandidate, result: ExtractReleaseOutcome | { error: unknown }) => void } = {},
): Promise<ExtractReleaseDrainResult> {
  const result: ExtractReleaseDrainResult = { extracted: 0, empty: 0, unparseable: 0, no_exhibits: 0, noop: 0, failed: 0 };
  let cursor = ZERO_UUID;
  for (;;) {
    const page = await findReleaseCandidates(deps.db, { afterClaimId: cursor, limit: opts.pageSize ?? 100 });
    if (page.length === 0) break;
    for (const candidate of page) {
      cursor = candidate.claimId;
      try {
        const outcome = await extractReleaseStatements(deps, candidate);
        result[outcome] += 1;
        opts.onClaim?.(candidate, outcome);
      } catch (error) {
        result.failed += 1;
        opts.onClaim?.(candidate, { error });
      }
    }
  }
  return result;
}
