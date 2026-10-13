import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalText,
  extractReleaseStatements,
  findReleaseCandidates,
  parseReleaseStatements,
  releaseExhibits,
  releasePrompts,
  runReleaseExtractionDrain,
  verifyStatement,
  type ExtractReleaseDeps,
} from "../src/sec-earnings-release-extraction.ts";
import type { QueryExecutor } from "../src/types.ts";
import { bootstrapDatabase, connectedClient, dockerAvailable } from "../../../db/test/docker-pg.ts";

const NVDA_CIK = 1045810;
const ACCESSION = "0001045810-25-000115";

// NVIDIA's Q1 FY2026 8-K (Item 2.02), cut down: the markup and wording are the
// filing's own (EX-99.2, CFO commentary), with an EX-99.1 and the documents a
// submission also carries.
const FONT = `<font style="color:#000000;font-family:'NVIDIA Sans',sans-serif;font-size:11pt;font-weight:400;line-height:120%">`;
const SUBMISSION = [
  "<SEC-DOCUMENT>0001045810-25-000115.txt",
  "<SEC-HEADER>ACCESSION NUMBER: 0001045810-25-000115 ITEM INFORMATION: Results of Operations and Financial Condition</SEC-HEADER>",
  "<DOCUMENT>\n<TYPE>8-K\n<TEXT>\n<html><body>Item 2.02 Results of Operations and Financial Condition. On May 28, 2025, NVIDIA issued a press release.</body></html>\n</TEXT>\n</DOCUMENT>",
  "<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<html><body><div>",
  `${FONT}NVIDIA Announces Financial Results for First Quarter Fiscal 2026</font></div>`,
  `<div>${FONT}Revenue of $44.1 billion, up 12% from the previous quarter and up 69% from a year ago</font></div>`,
  "</body></html>\n</TEXT>\n</DOCUMENT>",
  "<DOCUMENT>\n<TYPE>EX-99.2\n<TEXT>\n<html><body>",
  `<div style="margin-bottom:9pt;text-align:justify">${FONT}Our platforms address four large markets where our expertise is critical&#58; Data Center, Gaming, Professional Visualization, and Automotive.</font></div>`,
  `<div style="margin-bottom:9pt;text-align:justify">${FONT}On April 9, 2025, we were informed by the U.S. government that a license is required for exports of our H20 products into the China market. As a result of these new requirements, we incurred a $4.5 billion charge in the first quarter of fiscal 2026 associated with H20 excess inventory and purchase obligations as the demand for H20 diminished.</font></div>`,
  `${FONT}Outlook</font></div><div>${FONT}Outlook for the second quarter of fiscal 2026 is as follows&#58;</font></div>`,
  `<div style="padding-left:36pt">${FONT}&#8226;</font>${FONT}Revenue is expected to be $45.0 billion, plus or minus 2%. This outlook reflects a loss in H20 revenue of approximately $8.0 billion due to the recent export control limitations. </font></div>`,
  `<div>${FONT}NVIDIA&#8217;s gross margin was 60.5%,&nbsp;reflecting the H20 charge.</font></div>`,
  "</body></html>\n</TEXT>\n</DOCUMENT>",
  "<DOCUMENT>\n<TYPE>EX-101.SCH\n<TEXT>\n<xs:schema>gross margin</xs:schema>\n</TEXT>\n</DOCUMENT>",
  "</SEC-DOCUMENT>",
].join("\n");

const H20_EXPLANATION =
  "As a result of these new requirements, we incurred a $4.5 billion charge in the first quarter of fiscal 2026 associated with H20 excess inventory and purchase obligations as the demand for H20 diminished.";
const REVENUE_GUIDANCE = "Revenue is expected to be $45.0 billion, plus or minus 2%.";

test("an 8-K's EX-99 exhibits are read as plain text; the 8-K and XBRL documents are not", () => {
  const exhibits = releaseExhibits(SUBMISSION);
  assert.deepEqual(exhibits.map((exhibit) => exhibit.type), ["EX-99.1", "EX-99.2"]);
  const commentary = exhibits[1]!.text;
  assert.ok(commentary.includes(H20_EXPLANATION));
  // Entities decoded, typographic quotes made plain, tags gone.
  assert.ok(commentary.includes("critical: Data Center"));
  assert.ok(commentary.includes("NVIDIA's gross margin was 60.5%, reflecting the H20 charge."));
  assert.ok(!commentary.includes("<font"));
  assert.equal(canonicalText("a&nbsp;&nbsp;b &#x2014; c&rsquo;s"), "a b - c's");
});

test("a plain-text exhibit's headings and paragraphs are blocks, so the sentence under a heading verifies", () => {
  const exhibits = releaseExhibits([
    "<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>",
    "NVIDIA ANNOUNCES FINANCIAL RESULTS",
    "",
    "OUTLOOK",
    REVENUE_GUIDANCE,
    "Gross margins are expected to be 71.8%",
    "and 72.0%, respectively.",
    "</TEXT>\n</DOCUMENT>",
  ].join("\n"));
  assert.ok(verifyStatement({ kind: "guidance", metric: "revenue", quote: REVENUE_GUIDANCE }, exhibits), "under a heading");
  // A sentence wrapped across lines is still one sentence.
  const wrapped = "Gross margins are expected to be 71.8% and 72.0%, respectively.";
  assert.ok(verifyStatement({ kind: "guidance", metric: "gross_margin", quote: wrapped }, exhibits), "wrapped");
  assert.equal(verifyStatement({ kind: "guidance", metric: "gross_margin", quote: "Gross margins are expected to be 71.8%" }, exhibits), null, "a wrapped line alone");
  // CRLF line endings, as many plain-text filings have.
  const crlf = releaseExhibits("<DOCUMENT>\r\n<TYPE>EX-99.1\r\n<TEXT>\r\nFirst quarter results\r\n\r\nRevenue is expected to be $45.0 billion, plus or minus 2%.\r\n</TEXT>\r\n</DOCUMENT>");
  assert.ok(verifyStatement({ kind: "guidance", metric: "revenue", quote: REVENUE_GUIDANCE }, crlf), "after a CRLF blank line");
});

test("an HTML line break with attributes is a block edge", () => {
  const exhibits = releaseExhibits(
    `<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<html><body><p>Outlook<br style="clear:both">${REVENUE_GUIDANCE}</p></body></html>\n</TEXT>\n</DOCUMENT>`,
  );
  assert.ok(verifyStatement({ kind: "guidance", metric: "revenue", quote: REVENUE_GUIDANCE }, exhibits));
});

test("a release longer than one prompt is read whole, across prompts split between blocks", () => {
  const filler = Array.from({ length: 1_500 }, (_, n) => `Paragraph ${n} restates a figure from the quarter.`);
  const commentary = "Gross margin decreased primarily due to a charge associated with excess inventory.";
  const exhibits = releaseExhibits([
    `<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<html><body>${filler.map((sentence) => `<p>${sentence}</p>`).join("")}</body></html>\n</TEXT>\n</DOCUMENT>`,
    `<DOCUMENT>\n<TYPE>EX-99.2\n<TEXT>\n<html><body><p>${commentary}</p></body></html>\n</TEXT>\n</DOCUMENT>`,
  ].join("\n"));
  const prompts = releasePrompts(exhibits);
  assert.ok(prompts.length > 1, "more than one prompt");
  assert.ok(prompts.every((prompt) => prompt.length <= 60_000), "each within the cap");
  // Every block whole in some prompt, the commentary after the long release too.
  for (const sentence of [...filler, commentary]) {
    assert.ok(prompts.some((prompt) => prompt.includes(sentence)), sentence);
  }
  // A short release is one prompt.
  assert.equal(releasePrompts(releaseExhibits(SUBMISSION)).length, 1);
  // One block longer than a prompt is split between sentences (not after an
  // abbreviation's full stop), so each is whole in some prompt.
  const sentences = Array.from({ length: 1_500 }, (_, n) => `Sales in the U.S. Data Center market rose ${n}% on demand.`);
  const block = releaseExhibits(`<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<p>${sentences.join(" ")}</p>\n</TEXT>\n</DOCUMENT>`);
  const split = releasePrompts(block);
  assert.ok(split.length > 1 && split.every((prompt) => prompt.length <= 60_000));
  for (const sentence of sentences) assert.ok(split.some((prompt) => prompt.includes(sentence)), sentence);
});

test("the model's statements are read when well formed; unknown kinds or metrics are left out", () => {
  const statements = parseReleaseStatements(
    '```json\n{"statements":[' +
      `{"kind":"explanation","metric":"gross_margin","quote":${JSON.stringify(H20_EXPLANATION)}},` +
      '{"kind":"opinion","metric":"revenue","quote":"x"},' +
      '{"kind":"guidance","metric":"stock_price","quote":"x"},' +
      `{"kind":"guidance","metric":"revenue","quote":${JSON.stringify(REVENUE_GUIDANCE)}}` +
      "]}\n```",
  );
  assert.deepEqual(statements?.map((statement) => [statement.kind, statement.metric]), [["explanation", "gross_margin"], ["guidance", "revenue"]]);
  assert.equal(parseReleaseStatements("I could not find any."), null);
  assert.equal(parseReleaseStatements('{"quotes":[]}'), null);
  assert.deepEqual(parseReleaseStatements('{"statements":[]}'), []);
});

test("a statement is kept only as a verbatim quote of an exhibit, stored in the exhibit's own words", () => {
  const exhibits = releaseExhibits(SUBMISSION);
  const verified = verifyStatement({ kind: "explanation", metric: "gross_margin", quote: H20_EXPLANATION }, exhibits);
  assert.equal(verified?.exhibit, "EX-99.2");
  assert.equal(verified?.quote, H20_EXPLANATION);
  assert.equal(exhibits[1]!.text.slice(verified!.start, verified!.end), H20_EXPLANATION);

  // A curly apostrophe or extra spaces in the model's copy still match; the stored text is the exhibit's.
  const curly = verifyStatement({ kind: "explanation", metric: "gross_margin", quote: "NVIDIA’s gross margin  was 60.5%, reflecting the H20 charge." }, exhibits);
  assert.equal(curly?.quote, "NVIDIA's gross margin was 60.5%, reflecting the H20 charge.");

  // A clause cut from a sentence is not a quote of it: it can drop the words
  // that change its meaning.
  const negated = releaseExhibits(
    "<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<div>Gaming results were mixed. Revenue did not decline due to weaker demand in the quarter.</div>" +
      "<div>Data Center</div><div>Revenue was up 73%, driven by demand for our accelerated computing platform.</div>\n</TEXT>\n</DOCUMENT>",
  );
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "decline due to weaker demand in the quarter." }, negated), null);
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline due to weaker demand" }, negated), null);
  assert.ok(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline due to weaker demand in the quarter." }, negated));
  // A sentence after a heading block (no punctuation between) is whole.
  assert.ok(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue was up 73%, driven by demand for our accelerated computing platform." }, negated));
  // An abbreviation's full stop ends no sentence: neither the clause after it
  // nor the words up to it are one.
  const abbreviated = releaseExhibits(
    "<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<div>Revenue did not decline in the U.S. due to weaker demand.</div>\n</TEXT>\n</DOCUMENT>",
  );
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "due to weaker demand." }, abbreviated), null);
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline in the U.S." }, abbreviated), null);
  assert.ok(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline in the U.S. due to weaker demand." }, abbreviated));
  // Nor before a capitalized continuation ("the U.S. Data Center market").
  const continued = releaseExhibits(
    "<DOCUMENT>\n<TYPE>EX-99.1\n<TEXT>\n<div>Revenue did not decline in the U.S. Data Center market due to weaker demand.</div>\n</TEXT>\n</DOCUMENT>",
  );
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Data Center market due to weaker demand." }, continued), null);
  assert.equal(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline in the U.S." }, continued), null);
  assert.ok(verifyStatement({ kind: "explanation", metric: "revenue", quote: "Revenue did not decline in the U.S. Data Center market due to weaker demand." }, continued));

  // A paraphrase, an invented cause, or a fragment is not a quote.
  for (const quote of [
    "We incurred a $4.5 billion charge because demand for H20 fell.",
    "Gross margin fell due to a shift toward lower-margin gaming products.",
    "H20 charge.",
  ]) {
    assert.equal(verifyStatement({ kind: "explanation", metric: "gross_margin", quote }, exhibits), null, quote);
  }
});

// --- Against Postgres -------------------------------------------------------

function fakeLlm(text: string): { llm: ExtractReleaseDeps["llm"]; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    llm: {
      complete: async (request) => {
        calls.push(request.messages.map((message) => message.content).join("\n"));
        return { text, deployment: { channel: "test", model: "test-model" } };
      },
    },
  };
}

function fakeSec(submission: string): ExtractReleaseDeps["secClient"] {
  return {
    fetchFiling: async (input: { accession_number: string }) => ({
      bytes: new TextEncoder().encode(submission),
      contentType: "text/plain",
      retrievedAt: "2025-05-29T00:00:00.000Z",
      url: `https://www.sec.gov/Archives/edgar/data/1045810/x/${input.accession_number}.txt`,
    }),
  } as unknown as ExtractReleaseDeps["secClient"];
}

// An Item 2.02 claim as persist8kFiling writes it.
async function seedItem202(client: { query: QueryExecutor["query"] }): Promise<{ claimId: string; issuerId: string; documentId: string }> {
  const issuer = await client.query<{ id: string }>(
    `insert into issuers (legal_name, cik) values ('NVIDIA Corp', $1) returning issuer_id::text as id`,
    [String(NVDA_CIK).padStart(10, "0")],
  );
  const issuerId = issuer.rows[0]!.id;
  const source = await client.query<{ id: string }>(
    `insert into sources (provider, kind, trust_tier, license_class, retrieved_at)
     values ('sec_edgar', 'filing', 'primary', 'public', now()) returning source_id::text as id`,
  );
  const sourceId = source.rows[0]!.id;
  const document = await client.query<{ id: string }>(
    `insert into documents (source_id, kind, provider_doc_id, content_hash, raw_blob_id)
     values ($1, 'filing', $2, 'h-release', 'sha256:release') returning document_id::text as id`,
    [sourceId, ACCESSION],
  );
  const documentId = document.rows[0]!.id;
  const claim = await client.query<{ id: string }>(
    `insert into claims
       (document_id, predicate, text_canonical, polarity, modality, reported_by_source_id,
        attributed_to_type, attributed_to_id, effective_time, confidence, status)
     values ($1, 'material_event.guidance_update', 'Material event reported via 8-K: guidance update (2.02).',
             'neutral', 'asserted', $2, 'issuer', $3, '2025-05-28T00:00:00Z', 0.9, 'extracted')
     returning claim_id::text as id`,
    [documentId, sourceId, issuerId],
  );
  const claimId = claim.rows[0]!.id;
  await client.query(
    `insert into claim_arguments (claim_id, subject_kind, subject_id, role) values ($1, 'issuer', $2, 'subject')`,
    [claimId, issuerId],
  );
  return { claimId, issuerId, documentId };
}

test("an earnings release's verified quotes become management claims, once", { skip: !dockerAvailable(), timeout: 180_000 }, async (t) => {
  const { databaseUrl } = await bootstrapDatabase(t, "release-extraction");
  const client = await connectedClient(t, databaseUrl);
  const seeded = await seedItem202(client);
  const reply = JSON.stringify({ statements: [
    { kind: "explanation", metric: "gross_margin", quote: H20_EXPLANATION },
    { kind: "guidance", metric: "revenue", quote: REVENUE_GUIDANCE },
    // One sentence explaining two metrics is a claim for each.
    { kind: "explanation", metric: "operating_income", quote: H20_EXPLANATION },
    // Picked twice for the same metric, it is one.
    { kind: "explanation", metric: "gross_margin", quote: H20_EXPLANATION },
    // Invented: not in the filing, so never stored.
    { kind: "explanation", metric: "revenue", quote: "Revenue grew because every hyperscaler doubled its orders." },
  ] });
  const { llm, calls } = fakeLlm(reply);
  const deps: ExtractReleaseDeps = { db: client, llm, secClient: fakeSec(SUBMISSION) };

  const [candidate] = await findReleaseCandidates(client);
  assert.equal(candidate?.claimId, seeded.claimId);
  assert.equal(candidate?.accession, ACCESSION);
  assert.equal(await extractReleaseStatements(deps, candidate!), "extracted");
  // The model saw both exhibits, and only them.
  assert.match(calls[0]!, /\[EX-99\.1\][\s\S]*\[EX-99\.2\]/);
  assert.doesNotMatch(calls[0]!, /xs:schema/);

  const claims = (await client.query<{ predicate: string; text_canonical: string; modality: string; attributed_to_id: string; effective_time: Date; locator: { exhibit: string; start: number; end: number } }>(
    `select c.predicate, c.text_canonical, c.modality, c.attributed_to_id, c.effective_time, e.locator
       from claims c join claim_evidence e on e.claim_id = c.claim_id
      where c.claim_id <> $1 order by c.predicate`,
    [seeded.claimId],
  )).rows;
  assert.deepEqual(claims.map((claim) => [claim.predicate, claim.text_canonical, claim.modality]), [
    ["guidance.revenue", REVENUE_GUIDANCE, "quoted"],
    ["management.explanation.gross_margin", H20_EXPLANATION, "quoted"],
    ["management.explanation.operating_income", H20_EXPLANATION, "quoted"],
  ]);
  assert.ok(claims.every((claim) => claim.attributed_to_id === seeded.issuerId));
  assert.equal(claims[1]!.effective_time.toISOString(), "2025-05-28T00:00:00.000Z");
  assert.equal(claims[1]!.locator.exhibit, "EX-99.2");
  // Each is about the issuer, as the chat's claim reader selects them.
  const argued = await client.query(`select 1 from claim_arguments where subject_id = $1`, [seeded.issuerId]);
  assert.equal(argued.rowCount, 4);
  const audit = await client.query(`select 1 from tool_call_logs where tool_name = 'extract_earnings_release' and status = 'ok'`);
  assert.equal(audit.rowCount, 1, "the model call is recorded for audit");

  // Processed once: no longer a candidate, and a second pass over it changes nothing.
  assert.deepEqual(await findReleaseCandidates(client), []);
  assert.equal(await extractReleaseStatements(deps, candidate!), "noop");
  assert.equal((await client.query(`select 1 from claims where predicate like 'management.%' or predicate like 'guidance.%'`)).rowCount, 3);
});

test("a release the model answers badly stays a candidate, with nothing stored", { skip: !dockerAvailable(), timeout: 180_000 }, async (t) => {
  const { databaseUrl } = await bootstrapDatabase(t, "release-unparseable");
  const client = await connectedClient(t, databaseUrl);
  const seeded = await seedItem202(client);
  const { llm } = fakeLlm("Sorry, I can't help with that.");
  const result = await runReleaseExtractionDrain({ db: client, llm, secClient: fakeSec(SUBMISSION) });
  assert.equal(result.unparseable, 1);
  // Unread, so the next drain reads it again.
  assert.deepEqual((await findReleaseCandidates(client)).map((candidate) => candidate.claimId), [seeded.claimId]);
  assert.equal((await client.query(`select 1 from claims where claim_id <> $1`, [seeded.claimId])).rowCount, 0);
  // The model call is still recorded for audit.
  const audit = await client.query(`select 1 from tool_call_logs where tool_name = 'extract_earnings_release' and status = 'partial'`);
  assert.equal(audit.rowCount, 1);
});

test("a filing without EX-99 exhibits is marked processed without a model call", { skip: !dockerAvailable(), timeout: 180_000 }, async (t) => {
  const { databaseUrl } = await bootstrapDatabase(t, "release-no-exhibits");
  const client = await connectedClient(t, databaseUrl);
  await seedItem202(client);
  const { llm, calls } = fakeLlm('{"statements":[]}');
  const bare = SUBMISSION.replace(/<DOCUMENT>\n<TYPE>EX-99[\s\S]*?<\/DOCUMENT>/g, "");
  const result = await runReleaseExtractionDrain({ db: client, llm, secClient: fakeSec(bare) });
  assert.equal(result.no_exhibits, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(await findReleaseCandidates(client), []);
});
