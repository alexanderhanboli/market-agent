// The backstop on each rendered assertion (render-assertions.ts): a sentence
// of its text fails when a reference it cites ("[[F3]]", prose-refs.ts) is not
// in the turn's table. A template writes only the packet's values, as
// references, and periods; an analyst inference's words are the model's, and
// hold no digit (assertions.ts). Which company a reference belongs to is not
// checked here: the reference renders as the packet's own value, credited
// where the packet credits it.
//
// The rest of the guard reads the sentence with its references rendered to
// their displayed values: a magnitude or multiple in words (#228), and a cause
// the data does not show (#249, #261).
// ponytail: companies are recognized by their displayed label (ticker) only,
// case-sensitively, and never by a one-letter ticker (the article "A").

import { REFERENCE, renderedText, type ReferenceTable } from "./prose-refs.ts";

// The formatter writes no dotted currency prefix (a dotted symbol becomes its
// ISO code, #150), so every period before whitespace ends a sentence.
// "vs." abbreviates, it does not end a sentence ("($44.1B vs. $39.3B)", 2026-10-08 eval),
// nor does a letter-dot initialism before a lowercase word ("U.S. export
// controls"): a sentence cut there and dropped left half of it on the page
// (2026-10-15 run). Before a capital it ends one ("in the U.S. Revenue rose").
const SENTENCE_BREAK = /(?<=[.!?])(?<!\b[Vv]s\.)(?!(?<=\b(?:[A-Z]\.){2,})\s+\p{Ll})\s+/u;
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
// cannot show ("pricing power") goes too.
const CONNECTIVE = String.raw`(?:driven by|(?:lifted|boosted|pressured|helped|hurt|hit|weighed down|dragged down|squeezed) by|due to|because of|owing to|attributable to|as a result of|thanks to|on the back of|fuell?ed by|stemming from|caused by|result(?:s|ed)? from|reflect(?:s|ed|ing)?)`;
const CAUSAL = new RegExp(
  String.raw`\b${CONNECTIVE}\s+((?:(?!\b(?:although|though|but|while|whereas|yet|however|${CONNECTIVE})\b)[^,;:.])+)`,
  "gi",
);
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

export function unsupportedSentences(
  text: string,
  table: ReferenceTable,
  // The turn's displayed and cited text: the words a stated cause may use.
  supportingTexts: ReadonlyArray<string>,
): string[] {
  const figures = [...table.values()].flatMap((reference) => (reference.kind === "fact" ? [reference.figure] : []));
  // A one-letter ticker ("A") cannot be told from the article, so it is never
  // recognized as a company.
  const companies = [...new Set(figures.flatMap((figure) => figure.company ?? []))].filter((company) => company.length > 1);
  const vocabulary = new Set([
    ...supportingTexts.flatMap(causeWords),
    ...figures.flatMap((figure) => causeWords(`${figure.company ?? ""} ${figure.metric}`)),
  ]);
  const known = (word: string) => CAUSE_STOP.has(word) || CAUSE_DATA_WORDS.has(word) || vocabulary.has(word);
  const groundedCause = (sentence: string) =>
    [...sentence.matchAll(CAUSAL)].every((match) => causeWords(match[1]).every(known)) &&
    [...sentence.matchAll(ACTIVE_CAUSAL)].every((match) => causeWords(match[1]).every(known));
  return sentences(text).filter((written) => {
    // A reference the table does not hold is nothing the user can check.
    if ([...written.matchAll(REFERENCE)].some((match) => !table.has(match[1]!))) return true;
    // The checks below read the sentence as it renders, each reference its
    // displayed value, so a figure's magnitude reads as the user sees it.
    // Inline Markdown ("double **AMD's**") is ignored for all of them.
    const plain = renderedText(written, table).replace(/[*_`]+/g, "");
    // MULTIPLIER is case-sensitive so that a ticker ("AMD") counts as the
    // thing compared: the sentence is lowercased, whatever its case ("Six
    // Times AMD's", "SIX TIMES AMD'S"), and the companies' labels restored.
    const normalized = companies.reduce(
      (text, company) => text.replace(new RegExp(`(?<![a-z0-9])${escapeRegExp(company.toLowerCase())}(?![a-z0-9])`, "g"), company),
      plain.toLowerCase(),
    );
    return MAGNITUDE.test(plain) || MULTIPLIER.test(normalized) || !groundedCause(plain);
  });
}

// The sentences stating any cause, for an answer that shows no figures (#263):
// with nothing displayed there is no vocabulary to ground a cause in, so any
// stated cause goes, hedged or not. An explicit gap ("the data does not show
// why") names no cause.
export function causalSentences(text: string): string[] {
  return sentences(text).filter((written) => {
    const sentence = written.replace(/[*_`]+/g, "");
    return [...sentence.matchAll(CAUSAL)].length + [...sentence.matchAll(ACTIVE_CAUSAL)].length > 0;
  });
}

function sentences(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => (line.trim() === "" ? [] : line.trim().split(SENTENCE_BREAK)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
