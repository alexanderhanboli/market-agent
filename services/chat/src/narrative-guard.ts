// The model writes the narrative; it must not introduce figures. It writes a
// figure only as a packet reference ("[[F3]]", prose-refs.ts), so a sentence
// survives the figure check only if every reference it cites is in the turn's
// table and every digit outside a reference is a period label (an allowed
// year, or a quarter or half after Q or H). Everything else is dropped rather
// than shown unsupported. Which company a reference belongs to is not checked
// here: the reference renders as the packet's own value, credited where the
// packet credits it.
//
// The rest of the guard reads the sentence with its references rendered to
// their displayed values: a magnitude or multiple in words (#228), a cause the
// data does not show (#249, #261), and a hypothesis's basis (#262).
// ponytail: companies are recognized by their displayed label (ticker) only,
// case-sensitively, and never by a one-letter ticker (the article "A"); the
// prompt asks the model to use the label.

import { onlyPeriodDigits, REFERENCE, renderedText, type ReferenceTable } from "./prose-refs.ts";

// The formatter writes no dotted currency prefix (a dotted symbol becomes its
// ISO code, #150), so every period before whitespace ends a sentence.
// "vs." abbreviates, it does not end a sentence ("($44.1B vs. $39.3B)", 2026-10-08 eval),
// nor does a letter-dot initialism before a lowercase word ("U.S. export
// controls"): a sentence cut there and dropped left half of it on the page
// (2026-10-15 run). Before a capital it ends one ("in the U.S. Revenue rose").
export const SENTENCE_BREAK = /(?<=[.!?])(?<!\b[Vv]s\.)(?!(?<=\b(?:[A-Z]\.){2,})\s+\p{Ll})\s+/u;
// Markdown list markers ("- ", "* ", "1. ", "2) ") and headings ("## Margins",
// a line that is only "**Margins**"; a bold sentence ending "." is prose).
export const LIST_MARKER = /^\s*(?:[-*+]|\d{1,2}[.)])\s+/;
const HEADING = /^\s*(?:#{1,6}\s|\*\*[^*]*[^*.!?]\*\*:?\s*$)/;
// A magnitude comparison in words ("more than double", "thirteen times AMD's",
// "sixfold", "one in eight", "half as large", "a third of", "by a factor of
// six") is a computation the number check cannot see (#228): it always goes.
// Not even a cited claim licenses one, since a claim's "AMD's revenue doubled"
// must not ground "NVDA's revenue doubled"; the model quotes a displayed figure
// (a growth rate) instead. Direction ("higher") is not a magnitude.
// ponytail: a word list, not a parser; add a phrase when the eval shows one.
const COUNT = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|(?:a )?dozen)`;
const MAGNITUDE = new RegExp(
  String.raw`\b(?:(?:doubl|tripl|trebl|quadrupl|quintupl|sextupl|septupl|octupl)(?:ed(?! down\b| as an?\b)|(?:es|ing)(?! down\b| as\b))|halved|` +
    String.raw`(?:${COUNT}|several|many|multiple|a few|a couple of)[- ]?fold|${COUNT}[ -](?:in|out[ -]of)[ -](?:every[ -])?${COUNT}|${COUNT}[ -]of[ -]every[ -]${COUNT}|(?:increas|ris|rose|grew|grow|jump|climb|expand|surg|soar|fell|fall|declin|dropp?|shr[ai]nk|gain|slid|slip)\w* ${COUNT}(?:[- ]${COUNT})? (?:per ?cent|(?:percentage|basis) points?|points?|bps|bp)\b|(?<!(?:first|second|back|front|latter|former|last|later|earlier|1st|2nd)[ -])half (?:as|the size)|(?:a|${COUNT})[- ](?:third|fourth|quarter(?!s? (?:of|as) (?:results|data|history|figures|detail|segment|reported|financials|filings?|fiscal|FY|calendar|\d{4})\b)|fifth|sixth|seventh|eighth|ninth|tenth|hundredth)s? (?:of|as|that of|what|the (?:size|amount|level|value|total|revenue|sales|income|profit|earnings|margins?))|` +
    String.raw`orders? of magnitude|by half|(?:advantage|difference|gap|spread|lead|premium|discount|edge|deficit|shortfall)\b(?: [a-z]+){0,2}? (?:was|is|were|are|of|at|stood at|came to|reached|widened to|narrowed to|amounted to|totall?ed) (?:(?:${COUNT}(?:[- ]${COUNT})?|\d+(?:\.\d+)?) (?:(?:percentage|basis) points?|points?|per ?cent|bps|bp|dollars?|cents?|euros?|pounds?|yen|billion|million|trillion)\b|\d+(?:\.\d+)?%)|\d+(?:\.\d+)?[- ]?fold\b|${COUNT} and (?:an?|${COUNT})[- ](?:half|third|quarter|fourth|fifth)s? times\b|${COUNT}-times\b|${COUNT} (?:dollars?|cents?|euros?|pounds?|yen|yuan) (?:per|for each|for every) (?:${COUNT} )?(?:dollars?|cents?|euros?|pounds?|yen|yuan)\b|(?:${COUNT} times|twice) [^.,;:]*?\b(?:what|that of)\b|(?:increas|ris|rose|grew|grow|jump|climb|expand|surg|soar|fell|fall|declin|dropp?|shr[ai]nk|multipli)\w* (?:by )?\d+(?:\.\d+)?(?:[x×]|[- ]?fold)(?!\w)|(?:up|down) \d+(?:\.\d+)?(?:[x×]|[- ]?fold)(?!\w)|than (?:its |their |the |[A-Z]{2,}['’]s )?(?:entire|whole|combined) (?:[^\s.,;]+ ){0,3}?(?:revenue|sales|income|profit|earnings|margin|cash flow|base|value|total)\b|${COUNT}(?:[- ]${COUNT})? (?:points? (?:higher|lower|above|below|ahead|behind|more|less|wider|narrower)|(?:(?:billion|million|trillion)(?: dollars)?|dollars?|cents?|euros?|pounds?) (?:higher|lower|above|below|ahead|behind|more|less))|(?:exceed|beat|trail|lag|outpac|surpass|top|increas|rais|ris|rose|grew|grow|jump|climb|expand|surg|soar|fell|fall|declin|dropp?|shr[ai]nk|cut|lower|widen|narrow|boost)\w*(?: [A-Za-z'’]+){0,2}? by ${COUNT}(?:[- ]${COUNT})? (?:billion|million|trillion|dollars?|cents?|euros?|pounds?|yen|bps|bp|per ?cent|(?:percentage|basis) points?)|${COUNT}(?:[- ]${COUNT})? (?:(?:percentage|basis) points|points?|per ?cent|bps|bp|dollars?|cents?|euros?|pounds?|yen|yuan|rupees?|won|francs?) (?:higher|lower|above|below|ahead|behind|wider|narrower|more|less|greater|larger|smaller|bigger)\b|(?:${COUNT}|\d+(?:\.\d+)?)-to-${COUNT}|${COUNT}-to-\d+(?:\.\d+)?|(?:${COUNT}|\d+(?:\.\d+)?) to one\b|by (?:${COUNT}|several|many|a few|a couple of) times\b|${COUNT} (?:[a-z]+ )?for every ${COUNT}|(?:a|${COUNT})[- ](?:half|third|quarter|fourth|fifth|sixth|seventh|eighth|ninth|tenth|hundredth)s? (?:higher|lower|larger|smaller|bigger|greater|more|less)|(?:by )?a factor of (?:${COUNT}|several|a few|about|roughly|nearly|almost|over|more than))\b`,
  "i",
);
// Which phrases count (each case has a test):
// - "N times" after a number word or "twice": unless it ends the clause or
//   counts occurrences or frequency ("three times this year", "twice a month").
// - after digits: unless a valuation basis follows ("52.3 times earnings"), so
//   "52.3 times AMD's scale" and "52.3 times last year's level" go; a digit
//   "x", "×" or "fold" before a word likewise, unless the word is a valuation
//   basis, an occurrence or a connective ("52.3x is", "52.3x versus AMD's
//   41.2x"), so a displayed "52.3×" stays.
// - after "several", "many", "a few", "half", "hundreds of": only before the thing compared
//   ("several times AMD's", "many times larger"), so "volatile times" stays.
// - a bare "double"/"triple" after a degree word that ends the clause or meets
//   the thing compared ("nearly double.", "more than double AMD's"), or right
//   before the thing compared ("double AMD's"); not "double taxation",
//   "concern over triple-net leases" or "double bottom". "doubled" always counts,
//   except "doubled down", "doubles as collateral" and "doubled as a hedge".
// - "half" before the thing compared or "of", unless an ordinal half of a
//   period ("first half of NVDA's fiscal 2026").
// - worded differences ("forty percentage points", "fifty percent", "six
//   billion dollars more", "six dollars higher", "six bps higher", "six-to-one", "six dollars for
//   every one", "a third higher", "three out of four", "larger
//   than its entire revenue", "the margin gap was fifty percentage points" or
//   "53.6 percentage points", "six dollars per dollar", "a five-times
//   increase", "grew fifty percent", "one-in-eight"; "per cent" as well as
//   "percent"; "by <amount>" only after a
//   change or comparison verb, so "funded by six million dollars" stays; a gap
//   noun only with a measuring link, so "advantage stems from one million
//   developers" stays),
//   though a quantity ("three million units") or a direction ("faster than the
//   entire sector") is not one.
// - a digit percent against another company ("53.6% higher than AMD's"): a
//   displayed growth rate compares with a prior period, not a company.
// - "52.3x versus …" only stays before a second multiple ("versus AMD's
//   41.2x"); "half the year" is a duration.
// A valuation basis after a displayed multiple ("52.3 times earnings", "a
// 52.3× P/E multiple"): the figure is the multiple itself, not a ratio.
// Lowercase: MULTIPLIER sees the normalized (lowercased) sentence.
const VALUATION = String.raw`(?:(?:trailing |forward |ttm |ntm )?(?:earnings|sales|book|ebitda|ebit|revenue|cash flow|free cash flow|fcf|eps|p\/e|pe|p\/s|p\/b|ev\/ebitda|ev\/sales|price[- ]to[- ][a-z]+|multiple)\b)`;
// Occurrences and frequency after "N times" / "twice" ("three times this year",
// "3 times a month", "twice annually", "three times and then", "three times to
// discuss"): event counts.
const OCCURRENCE = String.raw`(?:this (?:year|quarter|month|week|period)\b(?!['’]s)|(?:in|during|since|so far|each|per|over|within|across|throughout|before|after|between|annually|yearly|quarterly|monthly|weekly|daily|and|or|but|then|while|when|to)\b|last (?:year|quarter|month)\b(?!['’]s)|a (?:year|quarter|month|week|day)\b)`;
const COMPARED = String.raw`(?:(?:the )?(?:last|prior|previous) (?:year|quarter|month|period)['’]s\b|year-ago\b|as\b|the\b|that of\b|of [A-Z]|its\b|their\b|what\b|(?:larger|bigger|greater|higher|lower|smaller|more|less|faster|slower)\b|[A-Z]{2,}\b)`;
const MULTIPLIER = new RegExp(
  String.raw`\b(?:${COUNT} times|twice)(?!\s*(?:[.,;:!?]|$)| ${OCCURRENCE})|` +
    String.raw`\b(?:several|many|a few|a couple of|multiple|half|(?:tens|dozens|hundreds|thousands|millions|billions) of) times ${COMPARED}|\b(?:double|triple|quadruple) ${COMPARED}|\b\d+(?:\.\d+)? times (?!${VALUATION}|${OCCURRENCE})[A-Za-z]|\b(?:more than|nearly|almost|roughly|about|over|less than|at least|close to) (?:double|triple|quadruple)(?=\s*(?:[.,;:!?)]|$)|\s+${COMPARED})|\b\d+(?:\.\d+)?(?:[xX×]|[- ]?fold) (?!${VALUATION}|${OCCURRENCE}|(?:is|was|are|were|and|or|but|for|at|on|to|from|by|with|while)\b|(?:versus|vs\.?) (?:[A-Z]{2,}['’]s )?\d)[A-Za-z]|\b\d+(?:\.\d+)?(?:%| per ?cent| percentage points?| basis points?| points?| bps) (?:(?:higher|lower|more|less|greater|larger|smaller|bigger) than|above|below|ahead of|behind) [A-Z]{2,}\b|` +
    String.raw`(?<!(?:[Ff]irst|[Ss]econd|[Bb]ack|[Ff]ront|[Ll]atter|[Ff]ormer|[Ll]ast|[Ll]ater|[Ee]arlier|1st|2nd)[ -])\b[Hh]alf (?!(?:of )?the (?:year|quarter|month|week|day|period|time|session|decade)\b)(?:of\b|${COMPARED})`,
);
// A stated cause ("driven by Data Center", "reflecting higher revenue") must be
// made of the answer's own data (#249): every content word after the causal
// connective comes from a displayed text, a cited claim (so a management
// attribution the turn cites passes), a metric or a company, or the short list
// of data words below. A hedge or disclaimer does not withdraw a cause ("could
// reflect pricing power, but the data does not show the cause" goes, #261); an
// explicit gap names none ("the data does not explain why margins rose").
// ponytail: a vocabulary check, not a semantic one; an interpretation the data
// cannot show ("pricing power") goes too, unless labelled as a hypothesis.
const CONNECTIVE = String.raw`(?:driven by|(?:lifted|boosted|pressured|helped|hurt|hit|weighed down|dragged down|squeezed) by|due to|because of|owing to|attributable to|as a result of|thanks to|on the back of|fuell?ed by|stemming from|caused by|result(?:s|ed)? from|reflect(?:s|ed|ing)?)`;
const CAUSAL = new RegExp(
  String.raw`\b${CONNECTIVE}\s+((?:(?!\b(?:although|though|but|while|whereas|yet|however|${CONNECTIVE})\b)[^,;:.])+)`,
  "gi",
);
// Whether an assertion states a cause: an observation or comparison may not
// (assertions.ts, #221). Only unambiguous connectives: "reflects" and "results
// from" also describe ("the table reflects the reported figures", "the results
// from FY2025"), so they are left to the guard's wider check on prose.
// Active verbs too ("charges caused", "led to", "drove", "resulted in", and
// financial causatives "lifted", "boosted", "pressured", "weighed on", #294
// review): unlike "reflects", these only ever say why.
// ponytail: a vocabulary, not a parser; checked takeaways and causes are #288.
const STRICT_CAUSAL = /\b(?:driven by|due to|because of|owing to|attributable to|as a result of|thanks to|on the back of|fuell?ed by|stemming from|caused by|resulted from|caus(?:ed|ing)|l(?:ed|ead|eads|eading) to|dr(?:ove|iving)|result(?:ed|ing) in|contribut(?:e|es|ed|ing) to|stem(?:s|med)? from|lift(?:ed|ing)|boost(?:ed|ing)|pressur(?:ed|ing)|weigh(?:s|ed|ing)? on|dragg?(?:s|ed|ing)? (?:on|down)|(?:could|may|might|would|will|can|should|to)\s+(?:lift|boost|pressure|drive|cause|lead to|weigh on|drag (?:on|down)|contribute to|result in))\b/i;
// An active causal verb in prose ("AI demand lifted revenue"): its cause is
// the few words before it, held to the same grounding as a connective's
// (#294 review). Not a passive "caused by", which CAUSAL reads.
// Its cause is the whole clause before it, back to a comma, colon or sentence
// start, so an invented cause cannot hide behind data words (#294 review).
// "Cause" and "causes" are nouns as often ("does not show a cause"): only
// "caused" and "causing" count.
const ACTIVE_VERB = String.raw`(?:caus(?:ed|ing)|l(?:ed|ead|eads|eading) to|dr(?:ove|iving)|result(?:ed|ing) in|contribut(?:e|es|ed|ing) to|lift(?:ed|ing)|boost(?:ed|ing)|pressur(?:ed|ing)|weigh(?:s|ed|ing)? on|dragg?(?:s|ed|ing)? (?:on|down)|(?:could|may|might|would|will|can|should|to)\s+(?:lift|boost|pressure|drive|cause|lead to|weigh on|drag (?:on|down)|contribute to|result in))`;
// Third-person "drives", "lifts", "boosts", "pressures" are plural nouns as
// often ("hard drives"), so they are left out (#294 review; see #296).
// Base forms ("could lift", "may drive", #294 review) count only after a modal
// or "to": bare "pressure" and "drive" are as often nouns.
const ACTIVE_CAUSAL = new RegExp(String.raw`((?:[^\s,;:.]+\s+)+?)${ACTIVE_VERB}\b(?!\s+by\b)`, "gi");

export function statesCause(text: string): boolean {
  return STRICT_CAUSAL.test(text);
}

// A cause the data does not show is allowed only as a labelled hypothesis (#261):
// a blockquote item with its confidence in words and one explanation, resting on
// an observation the answer shows ("> **Unverified hypothesis (medium
// confidence):** … may reflect …, given its gross margin of 70.8%").
// The basis is held to the cause check, and the numbers to the number check;
// any further sentence on the line is ordinary prose (#262 review). #208's
// analyst_inference replaces this label.
const HYPOTHESIS = /^\s*>\s*\*\*Unverified hypothesis \((?:low|medium|high) confidence\):\*\*\s+/i;
// A line claiming to be a hypothesis: the phrase at its start, behind any list,
// quote or bold marker; prose that mentions one ("would be an unverified
// hypothesis") claims nothing (#262 review).
const HYPOTHESIS_CLAIM = /^\s*(?:(?:[-*+]|\d{1,2}[.)])\s+)?(?:>\s*)?[*_]*\s*unverified hypothesis\b/i;
// Ordinary comparison and trend words a basis may use besides the answer's own.
// ponytail: a word list from the 2026-10-08 eval's phrasing; extend it from eval
// evidence, not invented sentences (#261).
const BASIS_WORDS = new Set([
  "versus", "vs", "compared", "relative", "while", "despite", "still", "even", "only", "after", "before", "since",
  "grew", "grow", "growing", "rose", "fell", "declined", "dropped", "expanded", "contracted", "recovered",
  "sequentially", "ending", "ended", "same", "prior", "previous", "following", "alongside", "adjacent",
]);
const BASIS = /\b(?:given|based on)\b(.*)$/i;
const MAX_HYPOTHESES = 2;
const CAUSE_STOP = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "its", "their", "that", "this", "these", "those", "to", "for",
  "with", "by", "from", "as", "at", "which", "both", "more", "less", "than", "over", "across", "into", "per", "each",
  "also", "it", "they", "is", "was", "were", "are", "be", "been", "largely", "mostly", "partly", "primarily",
  "mainly", "entirely", "company", "same",
]);
const CAUSE_DATA_WORDS = new Set([
  "reported", "mix", "figures", "figure", "data", "shown", "displayed", "higher", "lower", "stronger", "weaker",
  "rising", "falling", "larger", "smaller", "growth", "decline", "increase", "decrease", "revenue", "margin",
  "margins", "sales", "income", "profit", "profits", "earnings", "segment", "segments", "quarter", "quarters",
  "quarterly", "year", "years", "annual", "period", "periods", "fiscal", "price", "prices", "return", "returns",
  "above", "below",
]);
// A figure is not a word: its unit ("B" in "$209.9B") is dropped with it; any
// other digit-led term is ("5G" leaves "g"), and a fiscal year or quarter stays
// whole ("FY2025's", "Q4's"; #262 review).
const causeWords = (text: string) =>
  (text.toLowerCase().replace(/(?<![a-z0-9.,])\d[\d.,]*(?:bn|mn|tn|[bmktx])?\b/g, " ").match(/[a-z][a-z0-9'’-]*/g) ?? []).map((word) => word.replace(/['’]s$/, ""));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_WORDS = new Set(MONTHS.map((month) => month.toLowerCase()));

export function keepSupportedSentences(
  text: string,
  // The references the prose may cite, and the years it may write (prose-refs.ts).
  table: ReferenceTable,
  // The turn's displayed and cited text: the words a stated cause may use.
  supportingTexts: ReadonlyArray<string>,
  // The answer's subjects ("NVDA"), which a single-company answer's figures do
  // not carry: a hypothesis basis may name them (2026-10-08 eval).
  subjectLabels: ReadonlyArray<string> = [],
): { text: string; removed: string[] } {
  const figures = [...table.references.values()].flatMap((reference) => (reference.kind === "fact" ? [reference.figure] : []));
  // A one-letter ticker ("A") cannot be told from the article, so it is never
  // recognized as a company.
  const companies = [...new Set(figures.flatMap((figure) => figure.company ?? []))].filter((company) => company.length > 1);

  // The words a stated cause may use: the turn's own displayed and cited text.
  const vocabulary = new Set([
    ...supportingTexts.flatMap(causeWords),
    ...figures.flatMap((figure) => causeWords(`${figure.company ?? ""} ${figure.metric}`)),
  ]);
  // Each displayed metric as a whole name, without its qualifier ("Revenue
  // growth (QoQ)" -> "revenue growth"): one word of it ("gross") is no basis.
  const metricName = (metric: string) => causeWords(metric.replace(/\([^)]*\)/g, "")).join(" ");
  const metricNames = [...new Set(figures.map((figure) => metricName(figure.metric)).filter(Boolean))];
  // In a comparison, the metrics each company has displayed: a basis naming a
  // company cites one of its own ("given NVDA's gross margin" needs NVDA's).
  const metricsOwned = (company: string) =>
    figures.filter((figure) => figure.company === company).map((figure) => metricName(figure.metric));
  const known = (word: string) => CAUSE_STOP.has(word) || CAUSE_DATA_WORDS.has(word) || vocabulary.has(word);
  const groundedCause = (sentence: string) =>
    [...sentence.matchAll(CAUSAL)].every((match) => causeWords(match[1]).every(known)) &&
    [...sentence.matchAll(ACTIVE_CAUSAL)].every((match) => causeWords(match[1]).every(known));
  // A hypothesis's one explanation (a single causal clause), resting on an
  // observation of the answer's own: it names a displayed metric ("given its
  // gross margin of 70.8%"); not generic words ("given the data shown above"),
  // a title's wrapper words ("the side shown"), a company or a year alone
  // ("given NVDA", "based on 2026", #262 review).
  // ponytail: an explanation without a connective ("and an acquisition lifted
  // revenue") is not counted; #208's typed assertions bound that.
  const groundedBasis = (sentence: string) => {
    const basis = sentence.match(BASIS)?.[1];
    if (basis === undefined || [...sentence.matchAll(CAUSAL)].length > 1) return false;
    // Its words are the answer's own, or ordinary comparison and trend words
    // ("versus", "grew sequentially", "ending December", 2026-10-08 eval); an
    // invented premise ("after its inventory charge"), an unshown qualifier
    // ("subscription revenue") or another company ("at TSLA") is not (#265
    // review). A company is a compared one or the hypothesis's own subject,
    // the sentence's opening possessive ("NVDA's revenue may …"); another
    // capitalized word ("AI demand", "TSLA's pricing") is not one (#265 review).
    const subject = sentence.match(/^\s*([A-Z][A-Z0-9.]{1,5})['’]s\b/)?.[1];
    // The turn's subject labels only in a single-company answer, whose figures
    // carry no company; a comparison names its own (#268 review).
    const named = new Set([...companies, ...(companies.length === 0 ? subjectLabels : []), ...(subject === undefined ? [] : [subject])]);
    const words = causeWords(basis.replace(/\b([A-Z][A-Z0-9.]{1,5})(?:['’]s)?\b/g, (mention, ticker: string) => named.has(ticker) ? " " : mention));
    const cites = (name: string) => ` ${words.join(" ")} `.includes(` ${name} `);
    // A month only as the answer shows it, in full or abbreviated ("ended Jan
    // 2026" allows "January", not "December", #265 review).
    const shownMonth = (word: string) => MONTH_WORDS.has(word) && (vocabulary.has(word) || vocabulary.has(word.slice(0, 3)));
    return words.every((word) => (MONTH_WORDS.has(word) ? shownMonth(word) : known(word) || BASIS_WORDS.has(word))) &&
      metricNames.some(cites) &&
      companyMentions(basis, companies).every(({ company }) => metricsOwned(company).some(cites));
  };
  let hypotheses = 0;
  const removed: string[] = [];
  // null marks a line the guard dropped whole.
  const lines: Array<string | null> = [];
  // Lines are boundaries too, so each bullet of a list is judged on its own.
  for (const line of text.trim().split(/\r?\n/)) {
    if (line.trim() === "") {
      lines.push("");
      continue;
    }
    // A list marker ("1.", "-") is not a sentence: it is set aside, and stays
    // with whatever of its item is kept.
    // A labelled line is a hypothesis within the cap, or it goes whole (#262 review).
    // Any line claiming to be one counts toward the cap; one not in exactly the
    // labelled form (bold only, behind a list marker) goes whole.
    const label = line.match(HYPOTHESIS)?.[0];
    const claimed = label !== undefined || HYPOTHESIS_CLAIM.test(line);
    const withinCap = claimed && ++hypotheses <= MAX_HYPOTHESES;
    if (claimed && label === undefined) {
      removed.push(line.trim());
      lines.push(null);
      continue;
    }
    const lead = label ?? line.match(LIST_MARKER)?.[0] ?? line.match(/^\s*/)![0];
    const sentences = line.slice(lead.length).trim().split(SENTENCE_BREAK);
    const keeps = sentences.map((written, sentenceIndex) => {
      // A reference the table does not hold is nothing the user can check.
      const cited = [...written.matchAll(REFERENCE)].map((match) => match[1]!);
      if (cited.some((id) => !table.references.has(id))) {
        removed.push(written);
        return false;
      }
      // The checks below read the sentence as it renders, each reference its
      // displayed value, so a figure's magnitude or basis reads as before.
      // Inline Markdown ("double **AMD's**") is ignored for all of them.
      const plain = renderedText(written, table).replace(/[*_`]+/g, "");
      // MULTIPLIER is case-sensitive so that a ticker ("AMD") counts as the
      // thing compared: the sentence is lowercased, whatever its case ("Six
      // Times AMD's", "SIX TIMES AMD'S"), and the companies' labels restored.
      const normalized = companies.reduce(
        (text, company) => text.replace(new RegExp(`(?<![a-z0-9])${escapeRegExp(company.toLowerCase())}(?![a-z0-9])`, "g"), company),
        plain.toLowerCase(),
      );
      if (MAGNITUDE.test(plain) || MULTIPLIER.test(normalized) ||
        (label !== undefined && sentenceIndex === 0 ? !(withinCap && groundedBasis(plain)) : !groundedCause(plain))) {
        removed.push(written);
        return false;
      }
      // Any digit the model typed itself is a period label, or the sentence goes.
      if (!onlyPeriodDigits(written, table)) {
        removed.push(written);
        return false;
      }
      return true;
    });
    const kept = sentences.filter((_, index) => keeps[index]);
    if (label !== undefined && !keeps[0]) {
      removed.push(...kept);
      lines.push(null);
      continue;
    }
    lines.push(kept.length > 0 ? lead + kept.join(" ") : null);
  }
  return { text: withoutEmptySections(lines), removed };
}

// For an answer with no figures shown, which writes the values it was given
// (available_data, #181): only a sentence citing a reference the table does not
// hold goes, since nothing could render it.
export function keepKnownReferences(text: string, table: ReferenceTable): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = text.trim().split(/\r?\n/).map((line) => {
    if (line.trim() === "") return "";
    const lead = line.match(LIST_MARKER)?.[0] ?? line.match(/^\s*/)![0];
    const kept = line.slice(lead.length).trim().split(SENTENCE_BREAK).filter((sentence) => {
      const known = [...sentence.matchAll(REFERENCE)].every((match) => table.references.has(match[1]!));
      if (!known) removed.push(sentence);
      return known;
    });
    return kept.length > 0 ? lead + kept.join(" ") : null;
  });
  return { text: withoutEmptySections(lines), removed };
}

// The cause check alone, for an answer that shows no figures (#263): with
// nothing displayed there is no vocabulary to ground a cause in, so any stated
// cause goes, hedged or not. A labelled hypothesis within the cap keeps its
// first sentence when it gives one explanation and a basis with words in it
// ("given …"); any
// further sentence is ordinary prose. A line claiming to be one in any other
// form goes whole, as in keepSupportedSentences. An explicit gap ("the data
// does not show why") names no cause and stays. Numbers are not checked: there are none shown to check
// them against (#181).
export function keepUncausedSentences(text: string): { text: string; removed: string[] } {
  let hypotheses = 0;
  const removed: string[] = [];
  const lines: Array<string | null> = [];
  for (const line of text.trim().split(/\r?\n/)) {
    if (line.trim() === "") {
      lines.push("");
      continue;
    }
    const label = line.match(HYPOTHESIS)?.[0];
    const claimed = label !== undefined || HYPOTHESIS_CLAIM.test(line);
    const withinCap = claimed && ++hypotheses <= MAX_HYPOTHESES;
    if (claimed && label === undefined) {
      removed.push(line.trim());
      lines.push(null);
      continue;
    }
    const lead = label ?? line.match(LIST_MARKER)?.[0] ?? line.match(/^\s*/)![0];
    const sentences = line.slice(lead.length).trim().split(SENTENCE_BREAK);
    const keeps = sentences.map((written, index) => {
      const sentence = written.replace(/[*_`]+/g, "");
      const causes = [...sentence.matchAll(CAUSAL)].length + [...sentence.matchAll(ACTIVE_CAUSAL)].length;
      const keep = label !== undefined && index === 0
        ? withinCap && causes <= 1 && /[a-z0-9]/i.test(sentence.match(BASIS)?.[1] ?? "")
        : causes === 0;
      if (!keep) removed.push(written);
      return keep;
    });
    const kept = sentences.filter((_, index) => keeps[index]);
    // A hypothesis that fails goes whole, as in keepSupportedSentences.
    if (label !== undefined && !keeps[0]) {
      removed.push(...kept);
      lines.push(null);
      continue;
    }
    lines.push(kept.length > 0 ? lead + kept.join(" ") : null);
  }
  return { text: withoutEmptySections(lines), removed };
}

// The kept lines (null: dropped whole) as text. A heading whose section lost
// everything goes too: the guard dropped lines before the next heading at its
// level or above, and kept none of them. A heading with a figure in it
// ("## Revenue: $62.1B") is content: its figure passed the guard.
export function withoutEmptySections(lines: ReadonlyArray<string | null>): string {
  const level = (line: string | null) =>
    line !== null && HEADING.test(line) && !/\d/.test(line) ? line.trim().match(/^#+/)?.[0].length ?? 7 : 0;
  const keepHeading = (i: number): boolean => {
    let lost = false;
    for (const line of lines.slice(i + 1)) {
      if (line === null) lost = true;
      else if (line.trim() === "") continue;
      else if (level(line) === 0) return true;
      else if (level(line) <= level(lines[i])) break;
    }
    return !lost;
  };
  const shown = lines.filter((line, i): line is string => line !== null && (level(line) === 0 || keepHeading(i)));
  return shown.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Where each company label appears in the sentence, in order.
function companyMentions(
  sentence: string,
  companies: ReadonlyArray<string>,
): Array<{ company: string; index: number }> {
  return companies
    .flatMap((company) => {
      const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(company)}(?![A-Za-z0-9])`, "g");
      return [...sentence.matchAll(pattern)].map((match) => ({ company, index: match.index }));
    })
    .sort((a, b) => a.index - b.index);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
