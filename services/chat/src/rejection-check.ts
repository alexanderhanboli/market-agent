// Kept free of imports so scripts (the research-quality report) can name a
// rejection's check without loading chat's readers and their dependencies.

// The check a rejection failed, named so a report can tell a wrong number or
// citation (binding) from a wrong ranking or trend (comparative), and so a
// held-out mutation fails one named check (#221).
export type RejectionCheck =
  | "binding" | "comparative" | "reference" | "kind" | "cause" | "support" | "gap" | "limit" | "format" | "rendering" | "other";

const CHECKS: ReadonlyArray<readonly [RejectionCheck, RegExp]> = [
  ["comparative", /^comparison:/],
  ["rendering", /no fact to seal|states no ranking|narrative guard|left out of the answer|states no figures/],
  ["cause", /states no cause/],
  ["support", /inference binds|rests on/],
  ["gap", /named gap/],
  ["limit", /^more than \d+ assertions$/],
  ["reference", /^unknown evidence id|^unknown reference|twice$|evidence is not a list/],
  ["binding", /is not a cited figure's value|is not in its evidence|names no company|which its evidence does not|is not a cited date/],
  ["kind", /\bcites\b/],
  ["format", /^not an assertion|^unknown kind|^only an? |^supports is not/],
];

export function rejectionCheck(reason: string): RejectionCheck {
  return CHECKS.find(([, pattern]) => pattern.test(reason))?.[0] ?? "other";
}
