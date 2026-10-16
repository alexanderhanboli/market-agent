import { createHash } from "node:crypto";

// Adapts a hand-written fake to the generic `query<R>()` signature the
// repositories declare. The fake decides which rows come back; asserting them
// as R[] is the test double's contract, kept in this one place.
type FakeResult = { rows: readonly unknown[]; rowCount?: number };

export function fakeQuery(
  handler: (text: string, values?: unknown[]) => FakeResult | Promise<FakeResult>,
) {
  return async <R,>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number }> => {
    const result = await handler(text, values);
    return { ...result, rows: result.rows as R[] };
  };
}

/** A fake SEC fetch of `json`, completed at a fixed instant. */
export function secFetched(json: unknown, overrides: { url?: string; completed_at?: string } = {}) {
  return {
    url: overrides.url ?? "https://data.sec.gov/fake",
    body_sha256: createHash("sha256").update(JSON.stringify(json)).digest("hex"),
    completed_at: overrides.completed_at ?? "2026-05-08T00:00:00.000Z",
    json,
  };
}

const EMPTY_SUBMISSIONS = { filings: { recent: { accessionNumber: [], acceptanceDateTime: [] } } };

/** A fake SEC fetcher: `companyFacts()` for companyfacts paths, `submissions` (default: no filings) for the rest. */
export function secCompanyFetcher(companyFacts: () => unknown, options: { submissions?: unknown; completed_at?: string } = {}) {
  return async (path: string) =>
    path.startsWith("/api/xbrl/companyfacts/")
      ? secFetched(companyFacts(), { url: `https://data.sec.gov${path}`, completed_at: options.completed_at })
      : secFetched(options.submissions ?? EMPTY_SUBMISSIONS, { url: `https://data.sec.gov${path}`, completed_at: options.completed_at });
}
