import test from "node:test";
import assert from "node:assert/strict";

import { loadLocalRuntimeEvidence } from "../src/local-runtime-evidence.ts";
import type { QueryExecutor } from "../src/types.ts";
import { bootstrapDatabase, connectedClient, dockerAvailable } from "../../../db/test/docker-pg.ts";

// A chat route's claim selection (#207), end to end against Postgres: route
// predicates rank an older claim ahead of newer irrelevant ones, repeats count
// once, stored contradictions come back, and the cutoff and limit are explicit.

const ISSUER = "c1111111-1111-4111-8111-111111111111";
const INSTRUMENT = "c7777777-7777-4777-8777-777777777777";
const LISTING = "c8888888-8888-4888-8888-888888888888";
const FILINGS = "c2222222-2222-4222-8222-222222222222";
const NEWS = "c3333333-3333-4333-8333-333333333333";
const OLD_GUIDANCE = "c4000000-0000-4000-8000-000000000001";
const REPEAT_SAME_SOURCE = "c4000000-0000-4000-8000-000000000002";
const REPEAT_COPIED_DOCUMENT = "c4000000-0000-4000-8000-000000000003";
const KPI_UP = "c4000000-0000-4000-8000-000000000004";
const KPI_DOWN = "c4000000-0000-4000-8000-000000000005";
const AFTER_CUTOFF = "c4000000-0000-4000-8000-000000000006";
const INSIDER = (n: number) => `c5000000-0000-4000-8000-00000000000${n}`;

let documents = 0;
async function claim(
  db: QueryExecutor,
  input: { id: string; source: string; predicate: string; text: string; polarity: string; at: string; hash?: string },
): Promise<void> {
  const document = `c6000000-0000-4000-8000-${String(++documents).padStart(12, "0")}`;
  await db.query(
    `insert into documents (document_id, source_id, kind, content_hash, raw_blob_id, published_at, created_at)
     values ($1, $2, 'filing', $3, $4, $5, $5)`,
    [document, input.source, input.hash ?? `hash-${document}`, `sha256:${document}`, input.at],
  );
  await db.query(
    `insert into claims (claim_id, document_id, predicate, text_canonical, polarity, modality,
                         reported_by_source_id, effective_time, confidence, status, created_at)
     values ($1, $2, $3, $4, $5, 'asserted', $6, $7, 0.9, 'extracted', $7)`,
    [input.id, document, input.predicate, input.text, input.polarity, input.source, input.at],
  );
  await db.query(
    `insert into claim_arguments (claim_id, subject_kind, subject_id, role) values ($1, 'issuer', $2, 'subject')`,
    [input.id, ISSUER],
  );
}

test("a route's selection keeps an older decisive claim, counts repeats once, and returns contradictions", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(`insert into instruments (instrument_id, issuer_id, asset_type) values ($1, $2, 'common_stock')`, [INSTRUMENT, ISSUER]);
  await db.query(
    `insert into listings (listing_id, instrument_id, mic, ticker, trading_currency, timezone)
     values ($1, $2, 'XNAS', 'ACME', 'USD', 'America/New_York')`,
    [LISTING, INSTRUMENT],
  );
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now()), ($2, 'newswire', 'article', 'secondary', 'public', now())`,
    [FILINGS, NEWS],
  );
  const guidance = { predicate: "guidance.change", text: "Acme lowered its full-year revenue guidance.", polarity: "negative" };
  await claim(db, { id: OLD_GUIDANCE, source: FILINGS, ...guidance, at: "2025-05-01T00:00:00Z", hash: "hash-guidance" });
  // The same source saying it again, and a copy of the same document elsewhere.
  await claim(db, { id: REPEAT_SAME_SOURCE, source: FILINGS, ...guidance, at: "2025-05-02T00:00:00Z" });
  await claim(db, { id: REPEAT_COPIED_DOCUMENT, source: NEWS, ...guidance, at: "2025-05-03T00:00:00Z", hash: "hash-guidance" });
  await claim(db, { id: KPI_UP, source: FILINGS, predicate: "kpi.commentary", text: "Acme's backlog grew.", polarity: "positive", at: "2025-06-01T00:00:00Z" });
  await claim(db, { id: KPI_DOWN, source: NEWS, predicate: "kpi.commentary", text: "Acme's backlog shrank.", polarity: "negative", at: "2025-06-02T00:00:00Z" });
  for (let n = 1; n <= 5; n++) {
    await claim(db, { id: INSIDER(n), source: FILINGS, predicate: "insider.transaction", text: `Director ${n} sold shares.`, polarity: "neutral", at: `2026-0${n}-01T00:00:00Z` });
  }
  await claim(db, { id: AFTER_CUTOFF, source: FILINGS, predicate: "guidance.change", text: "Acme raised guidance.", polarity: "positive", at: "2026-09-01T00:00:00Z" });
  await db.query(
    `with cluster as (
       insert into claim_clusters (canonical_signature, first_seen_at, last_seen_at) values ('acme-backlog', now(), now()) returning cluster_id
     )
     insert into claim_cluster_members (cluster_id, claim_id, relation)
     select cluster_id, claim_id::uuid, relation from cluster, (values ($1, 'support'), ($2, 'contradict')) as m(claim_id, relation)`,
    [KPI_UP, KPI_DOWN],
  );
  // Chat covers a listing; the claims are argued about its issuer.
  const subject_refs = [{ kind: "listing" as const, id: LISTING }];
  const as_of = "2026-08-01T00:00:00Z";

  // Recency alone: five newer insider sales fill the five slots.
  const recent = await loadLocalRuntimeEvidence(db, { subject_refs, as_of });
  assert.deepEqual([...recent.claim_refs].sort(), [1, 2, 3, 4, 5].map(INSIDER).sort());

  const selected = await loadLocalRuntimeEvidence(db, {
    subject_refs,
    as_of,
    selection: { predicate_prefixes: ["guidance.", "kpi."], effective_from: "2024-08-01T00:00:00Z" },
  });
  const ids = selected.claim_refs;
  // The guidance claim once, as its first report, then both backlog claims and the newest sales.
  assert.deepEqual(ids.filter((id) => [OLD_GUIDANCE, REPEAT_SAME_SOURCE, REPEAT_COPIED_DOCUMENT].includes(id)), [OLD_GUIDANCE]);
  assert.ok(ids.includes(KPI_UP) && ids.includes(KPI_DOWN));
  assert.ok(!ids.includes(AFTER_CUTOFF), "a claim after the cutoff is never selected");
  assert.equal(ids.length, 5);
  assert.equal(selected.truncated, true);
  assert.deepEqual(selected.contradictions, [[KPI_UP, KPI_DOWN]]);
  // Each claim names the company (its issuer) it was matched for.
  assert.ok(selected.claims.every((selectedClaim) => selectedClaim.subject_id === ISSUER));

  // A claim from before the route's window ranks with the rest, by recency.
  const windowed = await loadLocalRuntimeEvidence(db, {
    subject_refs,
    as_of,
    selection: { predicate_prefixes: ["guidance."], effective_from: "2025-06-01T00:00:00Z" },
  });
  assert.deepEqual([...windowed.claim_refs].sort(), [1, 2, 3, 4, 5].map(INSIDER).sort());

  // A claim first reported before the window but repeated inside it keeps its place.
  const repeated = await loadLocalRuntimeEvidence(db, {
    subject_refs,
    as_of,
    selection: { predicate_prefixes: ["guidance."], effective_from: "2025-05-02T00:00:00Z" },
  });
  assert.ok(repeated.claim_refs.includes(REPEAT_SAME_SOURCE), "the in-window repeat stands for the claim");
  assert.equal(repeated.claim_refs.filter((id) => [OLD_GUIDANCE, REPEAT_SAME_SOURCE, REPEAT_COPIED_DOCUMENT].includes(id)).length, 1);
});

test("the same wording about two companies is two claims, and a claim names its subject, not a competitor (#207)", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-subjects");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  // Sorts before ISSUER, so an unordered pick would tend to name it.
  const RIVAL = "c0000000-0000-4000-8000-000000000001";
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc'), ($2, 'Rival Inc')`, [ISSUER, RIVAL]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const boilerplate = { source: FILINGS, predicate: "kpi.commentary", text: "Revenue increased year over year.", polarity: "positive" };
  await claim(db, { id: KPI_UP, ...boilerplate, at: "2026-03-01T00:00:00Z" });
  await claim(db, { id: KPI_DOWN, ...boilerplate, at: "2026-03-02T00:00:00Z" });
  await db.query(`update claim_arguments set subject_id = $1 where claim_id = $2`, [RIVAL, KPI_DOWN]);
  // Acme's claim also names the rival, as a competitor.
  await db.query(
    `insert into claim_arguments (claim_id, subject_kind, subject_id, role) values ($1, 'issuer', $2, 'competitor')`,
    [KPI_UP, RIVAL],
  );
  const selected = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }, { kind: "issuer", id: RIVAL }],
    selection: { predicate_prefixes: ["kpi."], effective_from: null },
  });
  assert.deepEqual(
    selected.claims.map((entry) => [entry.claim_id, entry.subject_id]).sort(),
    [[KPI_UP, ISSUER], [KPI_DOWN, RIVAL]].sort(),
  );
  // Asking about the rival alone: Acme's claim names it only as a competitor,
  // so it is not the rival's claim and is not selected.
  const rivalOnly = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: RIVAL }],
    selection: { predicate_prefixes: ["kpi."], effective_from: null },
  });
  assert.deepEqual(rivalOnly.claim_refs, [KPI_DOWN]);
});

test("a repeated claim stands as its first publication, even when the copies share an event date (#207)", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-first-report");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now()), ($2, 'newswire', 'article', 'secondary', 'public', now())`,
    [FILINGS, NEWS],
  );
  const event = { predicate: "material_event.officer_change", text: "Acme's CFO resigned.", polarity: "negative", at: "2026-04-01T00:00:00Z" };
  // The copy sorts first by id but was published a week later.
  await claim(db, { id: KPI_UP, source: NEWS, ...event });
  await claim(db, { id: KPI_DOWN, source: FILINGS, ...event });
  await db.query(
    `update documents set published_at = $2 from claims where claims.document_id = documents.document_id and claims.claim_id = $1`,
    [KPI_UP, "2026-04-08T00:00:00Z"],
  );
  const selected = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    selection: { predicate_prefixes: ["material_event."], effective_from: null },
  });
  assert.deepEqual(selected.claim_refs, [KPI_DOWN]);
});

test("the same statement in two quarters is two claims, and a comparison's slots are shared between its companies (#207)", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-periods");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  const RIVAL = "c0000000-0000-4000-8000-000000000001";
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc'), ($2, 'Rival Inc')`, [ISSUER, RIVAL]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const recurring = { source: FILINGS, predicate: "kpi.commentary", text: "Revenue increased year over year.", polarity: "positive" };
  await claim(db, { id: KPI_UP, ...recurring, at: "2026-02-01T00:00:00Z" });
  await claim(db, { id: KPI_DOWN, ...recurring, at: "2026-05-01T00:00:00Z" });
  const alone = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    selection: { predicate_prefixes: ["kpi."], effective_from: null },
  });
  assert.deepEqual(alone.claim_refs, [KPI_DOWN, KPI_UP], "each quarter's statement, newest first");
  // Undated statements are told apart by when they were published.
  await db.query(`update claims set effective_time = null where claim_id = any($1::uuid[])`, [[KPI_UP, KPI_DOWN]]);
  const undated = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    selection: { predicate_prefixes: ["kpi."], effective_from: null },
  });
  assert.deepEqual(undated.claim_refs, [KPI_DOWN, KPI_UP]);
  await db.query(`update claims set effective_time = created_at where claim_id = any($1::uuid[])`, [[KPI_UP, KPI_DOWN]]);

  // Acme has five newer route claims; the rival's one older claim still gets a slot.
  for (let n = 1; n <= 4; n++) {
    await claim(db, { id: INSIDER(n), source: FILINGS, predicate: "guidance.change", text: `Acme guidance note ${n}.`, polarity: "neutral", at: `2026-0${n + 5}-01T00:00:00Z` });
  }
  await claim(db, { id: OLD_GUIDANCE, source: FILINGS, predicate: "guidance.change", text: "Rival cut guidance.", polarity: "negative", at: "2025-12-01T00:00:00Z" });
  await db.query(`update claim_arguments set subject_id = $1 where claim_id = $2`, [RIVAL, OLD_GUIDANCE]);
  const compared = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }, { kind: "issuer", id: RIVAL }],
    selection: { predicate_prefixes: ["guidance.", "kpi."], effective_from: null },
  });
  assert.equal(compared.claim_refs.length, 5);
  assert.ok(compared.claim_refs.includes(OLD_GUIDANCE), "the rival's claim is not crowded out");
  assert.equal(compared.truncated, true);
});

// A route's prefixes are a priority, in order: its first family's claims come
// before newer ones of the next (management's explanations before a burst of
// newer guidance from the same releases).
test("a route reads its first predicate family before newer claims of the next", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-priority");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const EXPLANATION = "c4000000-0000-4000-8000-0000000000e1";
  await claim(db, {
    id: EXPLANATION,
    source: FILINGS,
    predicate: "management.explanation.gross_margin",
    text: "Gross margin decreased primarily due to an inventory charge.",
    polarity: "neutral",
    at: "2025-05-28T00:00:00Z",
  });
  for (let n = 1; n <= 6; n++) {
    await claim(db, { id: INSIDER(n), source: FILINGS, predicate: "guidance.revenue", text: `Acme guidance ${n}.`, polarity: "neutral", at: `2026-0${n}-01T00:00:00Z` });
  }
  const evidence = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    limit: 5,
    selection: { predicate_prefixes: ["management.", "guidance."], effective_from: null },
  });
  assert.equal(evidence.claim_refs[0], EXPLANATION, "the explanation, though older, comes first");
  assert.deepEqual(evidence.claim_refs.slice(1), [INSIDER(6), INSIDER(5), INSIDER(4), INSIDER(3)], "then the guidance, newest first");
});

// A question about one fiscal year reads that year's explanations, not the
// newer ones of later releases (the window has an end as well as a start).
test("a route's window ends where the period it asks about does", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-until");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const IN_YEAR = "c4000000-0000-4000-8000-0000000000e2";
  const explanation = { source: FILINGS, predicate: "management.explanation.gross_margin", polarity: "neutral" };
  await claim(db, { id: IN_YEAR, ...explanation, text: "Gross margin decreased due to an inventory charge.", at: "2025-05-28T00:00:00Z" });
  for (let n = 1; n <= 6; n++) {
    await claim(db, { id: INSIDER(n), ...explanation, text: `Gross margin moved for reason ${n}.`, at: `2026-0${n + 3}-01T00:00:00Z` });
  }
  const evidence = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    limit: 5,
    selection: { predicate_prefixes: ["management.explanation.gross_margin"], effective_from: "2025-01-01T00:00:00Z", effective_until: "2026-04-01T00:00:00Z" },
  });
  assert.equal(evidence.claim_refs[0], IN_YEAR, "the year's explanation, though older, comes first");
});

// A group of prefixes shares one priority: an operating income explanation in
// the newest release comes before revenue's in older ones.
test("a route's prefix group ranks its predicates together, newest first", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-group");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const OPERATING = "c4000000-0000-4000-8000-0000000000e3";
  const explanation = { source: FILINGS, polarity: "neutral" };
  for (let n = 1; n <= 5; n++) {
    await claim(db, { id: INSIDER(n), ...explanation, predicate: "management.explanation.revenue", text: `Revenue grew for reason ${n}.`, at: `2026-0${n}-01T00:00:00Z` });
  }
  await claim(db, { id: OPERATING, ...explanation, predicate: "management.explanation.operating_income", text: "Operating income fell on higher costs.", at: "2026-05-01T00:00:00Z" });
  const evidence = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    limit: 5,
    selection: {
      predicate_prefixes: [["management.explanation.revenue", "management.explanation.operating_income"], "management."],
      effective_from: null,
    },
  });
  assert.ok(evidence.claim_refs.includes(OPERATING), "the operating income explanation is read");
});

// A fiscal year is the issuer's own: one ending in September reads the releases
// about it (after its first quarter, until a quarter after it ends), not the
// next year's first quarter.
test("a fiscal year's window follows the issuer's fiscal calendar", async (t) => {
  if (!dockerAvailable()) return t.skip("docker unavailable");
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-selection-fiscal");
  const db = (await connectedClient(t, databaseUrl)) as unknown as QueryExecutor;
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1, 'Acme Inc')`, [ISSUER]);
  await db.query(
    `insert into sources (source_id, provider, kind, trust_tier, license_class, retrieved_at)
     values ($1, 'sec_edgar', 'filing', 'primary', 'public', now())`,
    [FILINGS],
  );
  const { rows: [metric] } = await db.query<{ metric_id: string }>(
    `insert into metrics (metric_key, display_name, unit_class, aggregation, interpretation, canonical_source_class)
     values ('revenue', 'Revenue', 'currency', 'sum', 'higher_is_better', 'filing') returning metric_id`,
  );
  await db.query(
    `insert into facts (subject_kind, subject_id, metric_id, period_kind, period_start, period_end, fiscal_year, fiscal_period,
                        value_num, unit, currency, as_of, observed_at, source_id, method, verification_status,
                        freshness_class, coverage_level, confidence)
     values ('issuer', $1, $2, 'fiscal_y', '2024-09-29', '2025-09-27', 2025, 'FY', 1, 'currency', 'USD', now(), now(), $3,
             'reported', 'authoritative', 'filing_time', 'full', 1)`,
    [ISSUER, metric!.metric_id, FILINGS],
  );
  const FY_Q4 = "c4000000-0000-4000-8000-0000000000e4";
  const explanation = { source: FILINGS, predicate: "management.explanation.gross_margin", polarity: "neutral" };
  await claim(db, { id: FY_Q4, ...explanation, text: "Gross margin rose on mix in the fourth quarter.", at: "2025-10-30T00:00:00Z" });
  // The next fiscal year's first quarter, still before the label's April fallback.
  await claim(db, { id: INSIDER(1), ...explanation, text: "Gross margin fell in the first quarter.", at: "2026-01-29T00:00:00Z" });
  const evidence = await loadLocalRuntimeEvidence(db, {
    subject_refs: [{ kind: "issuer", id: ISSUER }],
    limit: 1,
    selection: {
      predicate_prefixes: ["management.explanation.gross_margin"],
      effective_from: "2024-01-01T00:00:00.000Z",
      effective_until: "2026-04-01T00:00:00.000Z",
      fiscal_year: 2025,
    },
  });
  assert.deepEqual(evidence.claim_refs, [FY_Q4]);
});
