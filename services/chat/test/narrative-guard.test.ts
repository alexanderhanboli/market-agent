import assert from "node:assert/strict";
import test from "node:test";

import type { EvidencePacket, PacketFigure } from "../src/evidence-packet.ts";
import { keepSupportedSentences, keepUncausedSentences } from "../src/narrative-guard.ts";
import { referenceTable, type ReferenceTable } from "../src/prose-refs.ts";

type Figure = Partial<PacketFigure> & Pick<PacketFigure, "value" | "metric">;

// A table as a turn builds it: figures F1.. in order, claims C1.., the years of
// their periods and of the block titles.
function tableOf(figures: ReadonlyArray<Figure>, claims: ReadonlyArray<string> = [], titles: ReadonlyArray<string> = []): ReferenceTable {
  const packet: EvidencePacket = {
    route: "test",
    cutoff: "2026-09-01T00:00:00.000Z",
    companies: [...new Set(figures.flatMap((figure) => figure.company ?? []))],
    figures: figures.map((figure, i) => ({ id: `F${i + 1}`, source_ids: [], ...figure })),
    coverage: [],
    gaps: [],
    query_bounds: {},
    claims: claims.map((text, i) => ({ id: `C${i + 1}`, text, predicate: "kpi.commentary", stance: "neutral", claim_id: `claim-${i + 1}`, source_id: "s" })),
    disagreements: [],
    claims_status: claims.length > 0 ? "available" : "none",
    claims_truncated: false,
  };
  return referenceTable(packet, titles.map((title) => ({ kind: "metric_row", title })));
}

// A sentence written with references: each displayed value in it replaced by
// the token of the figure that shows it, as the model is asked to write.
function refs(sentence: string, figures: ReadonlyArray<Figure>): string {
  return figures.reduce((text, figure, i) => text.replaceAll(figure.value, `[[F${i + 1}]]`), sentence);
}

const QUARTER: Figure[] = [{ metric: "Revenue", period: "Q42026", value: "$62.1B" }];
const DISPLAYED = ["Revenue", "Quarterly revenue (Q1 2025 to Q4 2026)"];
const TABLE = tableOf(QUARTER, [], ["Latest quarter (Q4 2026)", "Quarterly revenue (Q1 2025 to Q4 2026)"]);

test("a sentence keeps its references when each is in the table; one citing an unknown id goes", () => {
  const text = "Revenue reached [[F1]] in Q4 2026. It rose every quarter.";
  assert.deepEqual(keepSupportedSentences(text, TABLE, DISPLAYED), { text, removed: [] });
  const result = keepSupportedSentences("Revenue reached [[F1]] in Q4 2026. Growth was [[F2]]. Margins held up.", TABLE, DISPLAYED);
  assert.equal(result.text, "Revenue reached [[F1]] in Q4 2026. Margins held up.");
  assert.deepEqual(result.removed, ["Growth was [[F2]]."]);
  assert.equal(keepSupportedSentences("Margins were [[C1]] strong.", TABLE, DISPLAYED).text, "");
});

test("an initialism does not end a sentence: a dropped sentence leaves no fragment behind", () => {
  const result = keepSupportedSentences("Results were hit by U.S. export rules costing $800 million. Revenue reached [[F1]] in Q4 2026.", TABLE, DISPLAYED);
  assert.equal(result.text, "Revenue reached [[F1]] in Q4 2026.");
  assert.deepEqual(result.removed, ["Results were hit by U.S. export rules costing $800 million."]);
});

test("a digit the model typed itself goes unless it is a period label: an allowed year, or a quarter or half after Q or H", () => {
  for (const kept of [
    "Revenue reached [[F1]] in Q4 2026.",
    "Revenue rose in fiscal 2026, from Q1 2025, and in H1 2026.",
    "Eight quarters are shown, through FY2026.",
    "Revenue grew over 2025-2026.",
  ]) {
    assert.deepEqual(keepSupportedSentences(kept, TABLE, DISPLAYED), { text: kept, removed: [] }, kept);
  }
  for (const dropped of [
    "That is 38% growth year over year.",
    "Revenue reached $62.1B in Q4 2026.",
    "Revenue was 62.1 billion dollars.",
    "Eight quarters are shown, 8 in all.",
    "Revenue has grown since 2019.",
    "The quarter ended January 25, 2026.",
    "Revenue reached [[F1]], up 1.5x.",
  ]) {
    assert.deepEqual(keepSupportedSentences(dropped, TABLE, DISPLAYED).removed, [dropped], dropped);
  }
});

test("which company a reference belongs to is not checked: the reference renders as the packet credits it", () => {
  const compared = tableOf([{ company: "NVDA", metric: "Gross margin", value: "74.6%" }, { company: "AMD", metric: "Gross margin", value: "49.2%" }]);
  // Read as "AMD's gross margin is 74.6%": the chip shows NVDA's figure and opens NVDA's fact.
  const swapped = "AMD's gross margin is [[F1]], ahead of NVDA at [[F2]].";
  assert.deepEqual(keepSupportedSentences(swapped, compared, []), { text: swapped, removed: [] });
});

test("a claim's reference renders its text: its numbers are the claim's, and its cause is grounded in the claim's own words", () => {
  const claim = "Export controls led to approximately $800 million in inventory and related charges.";
  const cited = tableOf([], [claim]);
  const text = "Management attributed the charge to export controls: [[C1]]";
  assert.deepEqual(keepSupportedSentences(text, cited, [claim]), { text, removed: [] });
  // The same words typed by the model are a figure and a cause of its own.
  assert.deepEqual(keepSupportedSentences(`Management said: ${claim}`, cited, [claim]).removed, [`Management said: ${claim}`]);
});

test("when every sentence is unsupported, nothing of the model's prose is kept", () => {
  const result = keepSupportedSentences("Revenue grew 45%. EPS hit $3.10.", TABLE, DISPLAYED);
  assert.equal(result.text, "");
  assert.equal(result.removed.length, 2);
});

test("guards each line of a bulleted answer on its own and keeps the line structure", () => {
  const result = keepSupportedSentences(
    "- Revenue reached [[F1]] in Q4 2026\n- Grew 38% year over year\n- Margins held up",
    TABLE,
    DISPLAYED,
  );
  assert.equal(result.text, "- Revenue reached [[F1]] in Q4 2026\n- Margins held up");
  assert.deepEqual(result.removed, ["Grew 38% year over year"]);
});

test("a numbered item keeps its marker, and loses it only with the whole item (#144)", () => {
  const result = keepSupportedSentences(
    "Highlights:\n\n1. Grew 38% year over year.\n2. Revenue reached [[F1]] in Q4 2026.\n3. Margins held up.",
    TABLE,
    DISPLAYED,
  );
  assert.equal(result.text, "Highlights:\n\n2. Revenue reached [[F1]] in Q4 2026.\n3. Margins held up.");
  assert.deepEqual(result.removed, ["Grew 38% year over year."]);
});

test("a heading whose whole section was dropped goes with it; one with content stays (#144)", () => {
  const result = keepSupportedSentences(
    "## Revenue\nRevenue reached [[F1]] in Q4 2026.\n\n**Growth**\n- Grew 38% year over year.\n\n### Margins\nGrew 38%.",
    TABLE,
    DISPLAYED,
  );
  assert.equal(result.text, "## Revenue\nRevenue reached [[F1]] in Q4 2026.");
  // A parent stays while a subsection under it keeps content.
  const nested = keepSupportedSentences(
    "## Analysis\n### Growth\nGrew 38%.\n### Revenue\nRevenue reached [[F1]] in Q4 2026.\n## Risks\n### Growth\nGrew 38%.",
    TABLE,
    DISPLAYED,
  );
  assert.equal(nested.text, "## Analysis\n### Revenue\nRevenue reached [[F1]] in Q4 2026.");
  // A bold sentence the guard kept is no empty heading, last line or not.
  for (const text of ["**Revenue reached [[F1]] in Q4 2026.**", "**Revenue reached [[F1]] in Q4 2026.**\n## Margins\nMargins held up."]) {
    assert.deepEqual(keepSupportedSentences(text, TABLE, DISPLAYED), { text, removed: [] });
  }
  // Nor goes with a dropped sentence after it.
  assert.equal(
    keepSupportedSentences("**Revenue reached [[F1]] in Q4 2026.**\nGrew 38%.", TABLE, DISPLAYED).text,
    "**Revenue reached [[F1]] in Q4 2026.**",
  );
  // Nor a heading that carries a figure the guard kept.
  for (const heading of ["**Revenue: [[F1]]**", "## Revenue: [[F1]]"]) {
    assert.equal(keepSupportedSentences(`${heading}\nGrew 38%.`, TABLE, DISPLAYED).text, heading);
  }
});

test("keeps paragraph breaks between supported paragraphs", () => {
  const text = "Revenue reached [[F1]] in Q4 2026.\n\nMargins held up.";
  assert.deepEqual(keepSupportedSentences(text, TABLE, DISPLAYED), { text, removed: [] });
});

test("sentences separated by a no-break space are still split", () => {
  for (const space of [" ", " "]) {
    const result = keepSupportedSentences(`NVDA led.${space}Growth was 38%.`, TABLE, DISPLAYED);
    assert.deepEqual(result.removed, ["Growth was 38%."], JSON.stringify(space));
  }
});

// Turn 3 of the golden conversation in the #194 eval run
// (docs/eval-runs/research-quality/2026-10-04T012140.md): the comparison's
// figures and the YTD chart's returns.
const GOLDEN: Figure[] = [
  { company: "NVDA", value: "$209.9B", metric: "Revenue", period: "FY2026", period_end: "2026-01-25" },
  { company: "NVDA", value: "70.8%", metric: "Gross Margin", period: "FY2026" },
  { company: "NVDA", value: "53.6%", metric: "Net Margin", period: "FY2026" },
  { company: "AMD", value: "$34.7B", metric: "Revenue", period: "FY2025", period_end: "2025-12-27" },
  { company: "AMD", value: "49.9%", metric: "Gross Margin", period: "FY2025" },
  { company: "AMD", value: "12.0%", metric: "Net Margin", period: "FY2025" },
  { company: "NVDA", value: "6.6%", metric: "Price return", period: "YTD 2026: December 2025 close to August 2026 close" },
  { company: "AMD", value: "3.58%", metric: "Price return", period: "YTD 2026: December 2025 close to August 2026 close" },
  { company: "NVDA", value: "60.9%", metric: "Revenue Growth (YoY)" },
  { company: "AMD", value: "34.5%", metric: "Revenue Growth (YoY)" },
  { company: "NVDA", value: "52.3x", metric: "P/E" },
  { company: "AMD", value: "41.2x", metric: "P/E" },
];
const GOLDEN_TABLE = tableOf(GOLDEN);
const golden = (sentence: string) => refs(sentence, GOLDEN);

test("the magnitude and multiplier checks read a reference as its displayed value (#228)", () => {
  for (const dropped of [
    // Every figure is a reference: only the magnitude is unsupported.
    "NVDA's net margin of 53.6% is more than double AMD's 12.0%.",
    "NVDA's net margin of 53.6% is more than four times AMD's 12.0%.",
    "NVDA is roughly six times AMD's scale.",
    "Data Center is nine-fold the next segment.",
    "Revenue nearly doubled over the period.",
    "Gaming is twice Automotive's size.",
    "About one in eight dollars came from Gaming.",
    "NVDA is thirteen times AMD's scale.",
    "NVDA is sixfold AMD's scale.",
    "AMD is half as large as NVDA.",
    "AMD is about a third of NVDA's size.",
    "Gaming is two-thirds of the remainder.",
    "AMD's revenue is less than half NVDA's.",
    "NVDA is several times AMD's scale.",
    "NVDA is two and a half times AMD's scale.",
    "NVDA's revenue is many times larger.",
    "Gaming is half of NVDA's remaining revenue.",
    "NVDA is an order of magnitude larger than AMD.",
    "AMD is a tenth of NVDA's size.",
    "Revenue fell by half.",
    "Half of NVDA's revenue came from Gaming.",
    "NVDA's revenue is several times its prior level.",
    "NVDA's revenue exceeds AMD's by a factor of six.",
    "NVDA earned several times what AMD reported.",
    // A displayed multiple does not license a ratio (#228 review).
    "NVDA is 52.3x AMD's scale.",
    "NVDA is 52.3x last year's level.",
    "Revenue is six times last year's level.",
    "Revenue is six times that reported by AMD.",
    "NVDA's revenue is nearly double AMD's.",
    "NVDA's margin is nearly double.",
    "NVDA's revenue is double AMD's.",
    "NVDA's margin was forty percentage points higher than AMD's.",
    "NVDA's margin was twenty-one points above AMD's.",
    "Six times AMD's revenue would approximate NVDA's.",
    "Several times AMD's scale is still short of NVDA.",
    "Double AMD's revenue would still trail NVDA.",
    "NVDA's gross margin of 70.8% was larger than its entire net margin of 53.6%.",
    "Half of total revenue came from Gaming.",
    "NVDA's revenue was fifty percent higher than AMD's.",
    "NVDA's revenue exceeded AMD's by fifty percent.",
    "NVDA's margin is a third higher than AMD's.",
    "NVDA's revenue was six billion dollars more than AMD's.",
    "NVDA's revenue exceeded AMD's by six billion.",
    "Four-fifths of revenue came from Gaming.",
    "Revenue was four fifths of last year's level.",
    "Revenue doubled as demand surged.",
    "**Six times AMD's revenue would approximate NVDA's.**",
    "Scale: Six Times AMD's Revenue",
    "Three out of four dollars came from Gaming.",
    "NVDA's revenue was four-fifths higher than last year's.",
    "NVDA's revenue was one-sixth higher than last year's.",
    "Three in four dollars came from Gaming.",
    "One in every eight dollars came from Gaming.",
    "Two of every three dollars came from Gaming.",
    "NVDA's revenue was double last year's level.",
    "NVDA's revenue was roughly double last year's level.",
    "AMD's revenue was half the prior quarter's level.",
    "Revenue was three times this year's level.",
    "Revenue was three times this quarter's level.",
    "Revenue is a couple of times larger than AMD's.",
    "Revenue was several-fold last year's level.",
    "NVDA's revenue was six-to-one versus AMD's.",
    "NVDA generated six dollars for every one dollar AMD generated.",
    "NVDA's EPS was six dollars higher than AMD's.",
    "NVDA's EPS exceeded AMD's by six dollars.",
    "Revenue is roughly double **AMD's**.",
    "Revenue is half **AMD's**.",
    "Revenue was hundreds of times larger than AMD's.",
    "Revenue was millions of times AMD's.",
    "NVDA's EPS was six yen higher than AMD's.",
    "NVDA's margin was six bps higher than AMD's.",
    "NVDA's revenue was fifty percent greater than AMD's.",
    "NVDA's revenue was a third the size of AMD's.",
    "AMD's revenue was three quarters the amount NVDA reported.",
    "SCALE: SIX TIMES AMD'S REVENUE",
    "NVDA's revenue exceeded AMD's by six times.",
    "NVDA's revenue was one tenth the revenue AMD reported.",
    "AMD's revenue was two-thirds what NVDA reported.",
    "NVDA's revenue was three-fourths that of AMD's.",
    "AMD's revenue was one-fourth of NVDA's.",
    "NVDA's margin was one-fourth higher than AMD's.",
    "NVDA's revenue quintupled.",
    "NVDA's revenue trebled.",
    "NVDA's revenue was one and a quarter times AMD's.",
    "NVDA's revenue was 53.6% higher than AMD's.",
    "NVDA's revenue was 52.3x versus AMD's.",
    "NVDA's margin advantage was fifty percentage points.",
    "The margin difference was fifty percentage points.",
    "NVDA's margin was 53.6% higher than AMD's.",
    "NVDA's revenue was one and two thirds times AMD's.",
    "NVDA's revenue was two and three quarters times AMD's.",
    "NVDA's revenue was fifty per cent higher than AMD's.",
    "NVDA generated six dollars per dollar AMD generated.",
    "NVDA generated six dollars for each dollar AMD generated.",
    "NVDA posted a five-times increase over AMD.",
    "NVDA's revenue was six and two-thirds times AMD's.",
    "NVDA's revenue grew fifty percent.",
    "NVDA's revenue fell fifty per cent year over year.",
    "One-in-eight dollars came from Gaming.",
    "Three-out-of-four dollars came from Gaming.",
  ]) {
    const written = golden(dropped);
    assert.deepEqual(keepSupportedSentences(written, GOLDEN_TABLE, []).removed, [written], written);
  }
  for (const kept of [
    // Direction without magnitude, and words that are not comparisons.
    "NVDA's net margin of 53.6% is higher than AMD's 12.0%.",
    "NVDA posted double-digit growth in the second half.",
    // A displayed multiple is a figure, read as such (#228 review).
    "NVDA's P/E was 52.3x.",
    "NVDA's P/E of 52.3x is well above AMD's.",
    "NVDA's P/E of 52.3x versus AMD's 41.2x.",
    "NVDA's net margin was 53.6%, higher than AMD's 12.0%.",
  ]) {
    const written = golden(kept);
    assert.deepEqual(keepSupportedSentences(written, GOLDEN_TABLE, []).removed, [], written);
  }
  // A displayed growth rate compares with a prior period, not another company.
  const growth = tableOf([{ metric: "Revenue growth (YoY)", value: "57.9%" }]);
  assert.deepEqual(keepSupportedSentences("Revenue was [[F1]] higher than a year earlier.", growth, []).removed, []);
  // A worded quantity that is not a difference is not a magnitude.
  for (const quantity of [
    "Management expects three million units next quarter.",
    "Management cut three billion dollars of costs.",
    "The launch was funded by six million dollars from investors.",
    "Management expects fifty percent of sales overseas.",
    "The fund owns one percent of the company.",
  ]) {
    assert.deepEqual(keepSupportedSentences(quantity, tableOf([], [quantity]), [quantity]).removed, [], quantity);
  }
  // Not even a claim licenses one: "AMD's revenue doubled" must not ground
  // "NVDA's revenue doubled" (#228 review). A displayed figure is quoted instead.
  const claimed = "NVDA's revenue doubled.";
  assert.deepEqual(keepSupportedSentences(claimed, tableOf(GOLDEN, ["AMD's revenue doubled year over year"]), ["AMD's revenue doubled year over year"]).removed, [claimed]);
  // And "first half" or "a quarter" of the calendar are not fractions of figures.
  const fiscal = tableOf([{ metric: "Revenue", period: "FY2026", value: "$1.0B" }, { metric: "Revenue", period: "FY2025", value: "$2.0B" }]);
  for (const kept of ["Revenue rose in the first half of fiscal 2026.", "Margins fell for a quarter before recovering.", "At times the margin dipped.", "Management cited demand many times.", "Revenue rose in the first half of NVDA's fiscal 2026.", "The second half of AMD's fiscal 2025 was weaker.", "Demand was a key factor of the growth.", "During volatile times the company defended margins.", "At other times the margin dipped.", "Management raised guidance three times.", "Management raised guidance three times this year.", "Management raised guidance three times last year.", "Management raised guidance three times over the last year.", "Revenue improved in the latter half of NVDA's fiscal year.", "The CEO made two points about demand.", "Management doubled down on data-center investment.", "Management is doubling down on AI.", "Management raised guidance twice this year.", "Management raised guidance twice.", "Management reviews guidance twice annually.", "The board meets twice a month.", "Results are reported three times a year.", "Investors remain concerned over double taxation.", "The REIT expressed concern over triple-net leases.", "Cash doubles as a buffer during downturns.", "The installed base doubles as a distribution channel.", "Revenue improved in the first half as demand recovered.", "NVDA grew faster than the entire semiconductor sector.", "Revenue was lower than the entire market expected.", "Revenue rose in the first-half of fiscal 2026.", "Revenue improved in the latter-half of NVDA's fiscal year.", "Revenue improved in the first-half as demand recovered.", "The filing presents one quarter of results.", "Only one quarter of segment detail is shown.", "Management revised guidance three times and then cut its outlook.", "The board met three times to discuss strategy.", "Revenue rose in one quarter of fiscal 2026.", "Cash doubles as collateral during downturns.", "The board doubles as the audit committee.", "Management plans two to three product launches.", "Management needs one more quarter to finish the ramp.", "The launch was delayed by three months.", "One risk is higher interest rates.", "Three products had higher sales.", "The company has one business with higher margins.", "Revenue grew over the 2025-to-2026 period.", "Of the two, one had higher margins.", "A dozen had lower sales.", "One ranked higher than the other.", "Revenue rose in the fourth quarter of fiscal 2026.", "Management raised guidance three times this year, which is what investors wanted.", "Management spent half the year integrating the acquisition.", "Revenue grew for half of the year.", "NVDA's advantage stems from one million developers.", "The funding gap affects one million customers.", "Management holds three meetings per year.", "Management highlighted the risk of double taxation.", "The chart formed a double bottom.", "The REIT uses triple-net leases."]) {
    assert.deepEqual(keepSupportedSentences(kept, fiscal, ["fiscal 2026", "fiscal 2025"]).removed, [], kept);
  }
});

test("a stated cause must be the answer's own data or a cited attribution; a hedge or disclaimer does not save it (#249, #261)", () => {
  // The turn shows these labels and cites a management claim; a cause built from them is grounded.
  const shown = [
    "Revenue by segment (Q4 2026)", "Data Center", "Gaming", "Side by side: NVDA FY2026 (ended Jan 2026), AMD FY2025 (ended Dec 2025)",
    "Management attributed the gross margin decline to lower Gaming pricing.",
  ];
  for (const dropped of [
    // The #228 eval's surviving cause, and the issue's examples.
    "NVDA's revenue is larger, reflecting its broader installed base and diversified product mix.",
    "NVDA's margins are higher, reflecting pricing power and operating leverage.",
    "AMD's net margin of 12.0% was likely due to a one-time charge.",
    "NVDA's gross margin of 70.8% is higher because of supply constraints.",
    // A hedge, a disclaimer or a denial does not withdraw a stated cause (#261).
    "NVDA's margins could reflect pricing power although the data does not show the cause.",
    "NVDA's higher margins may be driven by pricing power, but that cause is not shown by the data.",
    "The higher margins could reflect a narrower product mix, but the data shown does not identify the cause.",
    "The data does not show that NVDA's higher margins are driven by pricing power.",
    "That NVDA's higher margins are driven by pricing power is not shown by the data.",
    "We cannot see whether the improvement is driven by one business unit.",
    "The data does not identify the cause, so NVDA's higher margin reflects pricing power.",
    // The two #251 review cases, now intended drops (#260).
    "The data does not prove margins and revenue reflects pricing power.",
    "NVDA's margins may reflect pricing power and brand loyalty although the data does not show the cause.",
    // A hypothesis outside its label is an unlabelled cause.
    "Hypothesis: NVDA's margins reflect pricing power, given its gross margin of 70.8%.",
  ]) {
    const written = golden(dropped);
    assert.deepEqual(keepSupportedSentences(written, GOLDEN_TABLE, shown).removed, [written], written);
  }
  // A fiscal year or quarter keeps its possessive (#262 review; kept on main).
  const periods = tableOf([{ metric: "Revenue", period: "FY2025", value: "$62.1B" }, { metric: "Revenue", period: "Q42025", value: "$60.0B" }]);
  for (const kept of ["The margin reflects FY2025's revenue mix.", "The decline reflects Q4's lower revenue."]) {
    assert.deepEqual(keepSupportedSentences(kept, periods, ["FY2025 revenue", "Q4 revenue"]).removed, [], kept);
  }
  for (const kept of [
    "The data does not show a cause for the concentration; it simply reflects the reported mix.",
    "NVDA's revenue growth was driven by Data Center.",
    "NVDA's gross margin of 70.8% reflects higher revenue.",
    "The table reflects the reported figures for each segment.",
    // A management attribution the turn cites.
    "NVDA's gross margin decline was due to lower Gaming pricing, as management attributed it.",
    // An explicit gap names no cause.
    "The data shown does not explain why NVDA's margins rose.",
    "The data does not identify the cause of the margin decline.",
  ]) {
    const written = golden(kept);
    assert.deepEqual(keepSupportedSentences(written, GOLDEN_TABLE, shown).removed, [], written);
  }
});

test("a labelled hypothesis may state a cause the data does not show, with its basis and confidence, two at most (#261)", () => {
  const shown = ["Side by side: NVDA FY2026 (ended Jan 2026), AMD FY2025 (ended Dec 2025)"];
  const hypothesis = (confidence: string, body: string) => `> **Unverified hypothesis (${confidence} confidence):** ${golden(body)}`;
  const first = hypothesis("medium", "NVDA's higher margins may reflect pricing power, given its gross margin of 70.8% shown above.");
  const second = hypothesis("low", "AMD's lower net margin could be due to heavier spending, based on its net margin of 12.0%.");
  const answer = [golden("NVDA's gross margin of 70.8% is above AMD's 49.9%."), "", first, "", second].join("\n");
  assert.deepEqual(keepSupportedSentences(answer, GOLDEN_TABLE, shown), { text: answer, removed: [] });
  // A third hypothesis is one too many.
  const third = hypothesis("low", "NVDA's revenue may reflect brand loyalty, given its revenue of $209.9B.");
  assert.deepEqual(keepSupportedSentences([answer, "", third].join("\n"), GOLDEN_TABLE, shown).removed, [third.replace(/^> \*\*[^*]+\*\* /, "")]);
  for (const unlabelled of [
    // No stated basis, an unknown confidence, or no blockquote: an ordinary cause.
    hypothesis("medium", "NVDA's higher margins may reflect pricing power."),
    hypothesis("certain", "NVDA's higher margins reflect pricing power, given its gross margin of 70.8%."),
    `**Unverified hypothesis (medium confidence):** ${golden("NVDA's higher margins may reflect pricing power, given its gross margin of 70.8%.")}`,
  ]) {
    assert.equal(keepSupportedSentences(unlabelled, GOLDEN_TABLE, shown).text, "", unlabelled);
  }
  // Its basis must be the answer's own data, not an invented event (#262 review).
  assert.equal(keepSupportedSentences(hypothesis("medium", "NVDA's margins may reflect pricing power, given the recent product launch."), GOLDEN_TABLE, shown).text, "");
  // A labelled line is a hypothesis or nothing: grounded prose under the label,
  // without a basis or past the cap, goes whole (#262 review).
  const groundedThird = hypothesis("low", "NVDA's revenue may reflect higher revenue, given its revenue of $209.9B.");
  assert.deepEqual(keepSupportedSentences([answer, "", groundedThird].join("\n"), GOLDEN_TABLE, shown).removed, [groundedThird.replace(/^> \*\*[^*]+\*\* /, "")]);
  assert.equal(keepSupportedSentences(hypothesis("medium", "NVDA's revenue may reflect higher revenue."), GOLDEN_TABLE, shown).text, "");
  // A labelled line whose hypothesis goes takes the rest of the line with it.
  const malformed = hypothesis("medium", "NVDA's revenue may reflect brand loyalty. NVDA's gross margin of 70.8% is above AMD's 49.9%.");
  assert.equal(keepSupportedSentences(malformed, GOLDEN_TABLE, shown).text, "");
  // By position, not text: a repeated first sentence is no stand-in (#262 review).
  const repeated = hypothesis("medium", "NVDA's revenue may reflect higher revenue. NVDA's revenue may reflect higher revenue.");
  assert.equal(keepSupportedSentences(repeated, GOLDEN_TABLE, shown).text, "");
  // Behind a list marker, or malformed, a labelled line still counts and must be valid (#262 review).
  const listed = "- " + hypothesis("low", "NVDA's revenue may reflect higher revenue, given its revenue of $209.9B.");
  assert.deepEqual(keepSupportedSentences([answer, "", listed].join("\n"), GOLDEN_TABLE, shown).text, answer);
  const bold = `**Unverified hypothesis (medium confidence):** ${golden("NVDA's revenue may reflect higher revenue, given its revenue of $209.9B.")}`;
  assert.equal(keepSupportedSentences(bold, GOLDEN_TABLE, shown).text, "");
  // A basis names a metric of a company that has it displayed (#262 review).
  const withoutReturn = GOLDEN.filter((figure) => !(figure.company === "AMD" && figure.metric === "Price return"));
  assert.equal(keepSupportedSentences(hypothesis("low", "AMD's revenue may reflect pricing power, given AMD's price return."), tableOf(withoutReturn), shown).text, "");
  // A basis may name only its own subject or a compared company, not another (#262 review).
  assert.equal(keepSupportedSentences(hypothesis("low", "NVDA's revenue may reflect pricing power, given TSLA's revenue of $209.9B."), GOLDEN_TABLE, shown).text, "");
  // Only a label at the line's start claims a hypothesis: prose that mentions one
  // stays, and takes none of the two slots (#262 review).
  const mention = golden("NVDA's gross margin of 70.8% is above AMD's 49.9%. The data does not establish a cause; any explanation would be an unverified hypothesis.");
  const mentioned = [mention, "", first, "", second].join("\n");
  assert.deepEqual(keepSupportedSentences(mentioned, GOLDEN_TABLE, shown), { text: mentioned, removed: [] });
  // The eval's own hypotheses: a basis in ordinary words passes once it names a
  // displayed metric and cites only shown figures (2026-10-08 eval).
  const evalCase = hypothesis("medium", "AMD's lower net margin relative to its gross margin could reflect higher operating expenses as a share of revenue, given AMD's gross margin of 49.9% versus net margin of 12.0% for FY2025 (ending December 2025).");
  assert.deepEqual(keepSupportedSentences(evalCase, GOLDEN_TABLE, shown).removed, []);
  const BARS: Figure[] = [{ metric: "Revenue", period: "Q4 2025", value: "$39.3B" }, { metric: "Revenue", period: "Q1 2026", value: "$44.1B" }];
  const bars = tableOf(BARS, [], ["Quarterly revenue"]);
  // The bars' labels are displayed text, as the runtime supplies them.
  const BAR_TEXTS = ["Quarterly revenue", "Q4 2025", "Q1 2026"];
  const barred = (body: string) => `> **Unverified hypothesis (low confidence):** ${refs(body, BARS)}`;
  const sequential = barred("A shift in product or customer mix toward lower-margin offerings may have weighed on Q1 fiscal 2026, given that revenue of $44.1B in that quarter still grew sequentially from $39.3B in Q4 fiscal 2025.");
  assert.deepEqual(keepSupportedSentences(sequential, bars, BAR_TEXTS).removed, []);
  // Ordinary comparison words pass, but not an invented premise, an unshown
  // qualifier of the metric, or another company (#265 review).
  const comparison = tableOf([{ company: "NVDA", value: "70.8%", metric: "Gross margin" }, { company: "AMD", value: "49.9%", metric: "Gross margin" }]);
  assert.equal(keepSupportedSentences(hypothesis("low", "NVDA's higher margins may reflect pricing power, given NVDA's gross margin of [[F1]] after its inventory charge was reversed."), comparison, ["Quarterly revenue"]).text, "");
  for (const basis of [
    "NVDA's growth may reflect demand, given subscription revenue of $44.1B in Q1 fiscal 2026.",
    "NVDA's growth may reflect stronger industry demand, given revenue of $44.1B at TSLA.",
    // An acronym in the explanation is no company: "AI revenue" is not the revenue shown (#265 review).
    "NVDA's revenue may reflect AI demand, given AI revenue of $44.1B.",
    // Only the subject's possessive, not another company's in the explanation (#265 review).
    "NVDA's revenue may reflect TSLA's pricing, given TSLA revenue of $44.1B.",
  ]) {
    assert.equal(keepSupportedSentences(barred(basis), bars, BAR_TEXTS).text, "", basis);
  }
  // A month is one the answer shows, in full or abbreviated ("ended Jan 2026"), not any (#265 review).
  const FISCAL: Figure[] = [{ metric: "Revenue", period: "FY2026", value: "$209.9B" }];
  const fiscal = tableOf(FISCAL, [], ["NVDA FY2026 (ended Jan 2026)"]);
  const month = (name: string) => `> **Unverified hypothesis (low confidence):** NVDA's revenue may reflect demand, given NVDA's revenue of [[F1]] for FY2026 ending ${name} 2026.`;
  assert.equal(keepSupportedSentences(month("December"), fiscal, ["NVDA FY2026 (ended Jan 2026)", "Revenue"]).text, "");
  assert.deepEqual(keepSupportedSentences(month("January"), fiscal, ["NVDA FY2026 (ended Jan 2026)", "Revenue"]).removed, []);
  // A fiscal period's possessive is a period, not a ticker (#265 review).
  const quarter = barred("NVDA's revenue may reflect stronger demand, given Q4's revenue of $39.3B.");
  assert.deepEqual(keepSupportedSentences(quarter, bars, BAR_TEXTS).removed, []);
  // "vs." does not end the hypothesis, and "alongside" is a comparison word (2026-10-08 eval).
  const versus = barred("A product-mix shift ($44.1B vs. $39.3B in revenue) may have weighed on margins, given that revenue still grew sequentially in Q1 2026.");
  assert.deepEqual(keepSupportedSentences(versus, bars, BAR_TEXTS).removed, []);
  const alongside = barred("Demand may explain it, given revenue of $44.1B alongside revenue of $39.3B.");
  assert.deepEqual(keepSupportedSentences(alongside, bars, BAR_TEXTS).removed, []);
  // In a comparison, a requested subject with no figures is no exemption (#268 review).
  const partial = hypothesis("low", "NVDA's revenue may reflect demand, given TSLA's revenue of $209.9B.");
  assert.equal(keepSupportedSentences(partial, GOLDEN_TABLE, shown, ["NVDA", "AMD", "TSLA"]).text, "");
  // A basis naming no displayed metric is still none, however worded.
  assert.equal(keepSupportedSentences(barred("Margins may reflect a one-time charge, given that the margin recovered by Q2 fiscal 2026."), tableOf([{ metric: "Gross margin", value: "70.8%", period: "Q2 2026" }]), ["Quarterly revenue"]).text, "");
  // A figure with a unit is a basis, and a cause, like any other.
  const scaled = hypothesis("low", "NVDA's revenue may reflect Data Center demand, given its revenue of $209.9B.");
  assert.equal(keepSupportedSentences(scaled, GOLDEN_TABLE, [...shown, "Data Center"]).text, scaled);
  // An empty or generic basis is none (#262 review).
  for (const basis of ["given.", "given the data shown above.", "given the side shown above.", "given NVDA.", "based on 2026.", "given gross.", "given margin."]) {
    assert.equal(keepSupportedSentences(hypothesis("medium", `NVDA's margins may reflect pricing power, ${basis}`), GOLDEN_TABLE, shown).text, "", basis);
  }
  // One causal clause per hypothesis (#262 review).
  assert.equal(keepSupportedSentences(hypothesis("medium", "NVDA's margins may reflect pricing power and its revenue was driven by a secret acquisition, given its gross margin of 70.8% shown above."), GOLDEN_TABLE, shown).text, "");
  // One explanation per hypothesis: a second sentence on the line is checked as ordinary prose (#262 review).
  const extra = golden("NVDA's margin was also driven by a secret acquisition, given its gross margin of 70.8%.");
  assert.deepEqual(keepSupportedSentences(`${first} ${extra}`, GOLDEN_TABLE, shown), { text: first, removed: [extra] });
  // A hypothesis still cites only references the table holds.
  assert.equal(keepSupportedSentences(hypothesis("high", "NVDA's margins may reflect pricing power, given its gross margin of [[F99]]."), GOLDEN_TABLE, shown).text, "");
});

test("with no figures shown, only causes are checked, and any stated cause goes (#263)", () => {
  const hypothesis = (n: number) => `> **Unverified hypothesis (medium confidence):** Margins may reflect product mix ${n}, given the revenue shown.`;
  const { text, removed } = keepUncausedSentences([
    "## Takeaway",
    "AMD earned $1.5B. The decline was due to a one-time charge. Revenue could reflect pricing power, but the data does not say.",
    "The data does not show why margins fell.",
    "## Drivers",
    "- Driven by data center demand.",
    hypothesis(1),
    hypothesis(2),
    hypothesis(3),
    "**Unverified hypothesis:** Supply constraints.",
  ].join("\n"));
  assert.equal(text, [
    "## Takeaway",
    "AMD earned $1.5B.",
    "The data does not show why margins fell.",
    "## Drivers",
    hypothesis(1),
    hypothesis(2),
  ].join("\n"));
  assert.deepEqual(removed, [
    "The decline was due to a one-time charge.",
    "Revenue could reflect pricing power, but the data does not say.",
    "Driven by data center demand.",
    // Past the cap: its sentence, as keepSupportedSentences reports it.
    "Margins may reflect product mix 3, given the revenue shown.",
    "**Unverified hypothesis:** Supply constraints.",
  ]);
  // A section that loses everything loses its heading.
  assert.equal(keepUncausedSentences("## Why\nIt rose due to demand.\n## Next\nAMD grew.").text, "## Next\nAMD grew.");
});

test("with no figures shown, a hypothesis keeps one explanation and its basis; the rest of its line is prose (#263)", () => {
  const label = "> **Unverified hypothesis (medium confidence):**";
  const check = (line: string) => keepUncausedSentences(line);
  // A further sentence stating a cause goes; the hypothesis stays.
  assert.deepEqual(check(`${label} Demand may reflect mix, given revenue. Revenue was driven by an acquisition.`), {
    text: `${label} Demand may reflect mix, given revenue.`,
    removed: ["Revenue was driven by an acquisition."],
  });
  // No basis, or two explanations: the line goes whole.
  assert.equal(check(`${label} Demand may reflect mix.`).text, "");
  assert.equal(check(`${label} Demand may reflect mix, driven by pricing, given revenue.`).text, "");
  // A basis marker with nothing after it is no basis.
  assert.equal(check(`${label} Margins may reflect a secret acquisition, given.`).text, "");
});

const NVDA_REVENUE: Figure[] = [{ company: "NVDA", value: "$209.9B", metric: "Revenue", period: "FY2026" }];
const nvda = (text: string) => keepSupportedSentences(refs(text, NVDA_REVENUE), tableOf(NVDA_REVENUE), [], ["NVDA"]);

test("an active causal verb's cause is checked like a connective's (#294 review)", () => {
  // The cause ("AI demand", "charges") is not the answer's data: removed.
  assert.deepEqual(nvda("AI demand lifted NVDA's revenue to $209.9B.").removed, ["AI demand lifted NVDA's revenue to [[F1]]."]);
  assert.deepEqual(nvda("Charges caused NVDA's revenue to reach $209.9B.").removed.length, 1);
  // A plain movement states no cause: kept.
  assert.deepEqual(nvda("NVDA's revenue rose to $209.9B.").removed, []);
  // With no figures shown, an active cause goes too.
  assert.equal(keepUncausedSentences("Inventory charges weighed on AMD's results.").removed.length, 1);
});

test("a passive financial causative is a cause; the noun \"results in\" is not (#294 review)", () => {
  assert.equal(nvda("NVDA's revenue was lifted by AI demand to $209.9B.").removed.length, 1);
  assert.equal(nvda("NVDA's revenue was boosted by pricing to $209.9B.").removed.length, 1);
  assert.deepEqual(nvda("The results in FY2026 include NVDA's revenue of $209.9B.").removed, []);
});

test("a base-form causative after a modal is checked in prose too (#294 review)", () => {
  assert.equal(nvda("AI demand could lift NVDA's revenue to $209.9B.").removed.length, 1);
});

test("an active causal verb's whole clause before it is its cause, not its last four words (#294 review)", () => {
  assert.equal(nvda("A new product launch across the company's reported segments lifted NVDA's revenue to $209.9B.").removed.length, 1);
});
