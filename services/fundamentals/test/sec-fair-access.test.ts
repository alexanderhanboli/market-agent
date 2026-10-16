import test from "node:test";
import assert from "node:assert/strict";

import { withSecFairAccess } from "../src/sec-edgar-http.ts";
import { SecEdgarFetchError } from "../src/sec-edgar.ts";
import { secFetched } from "./fakes.ts";

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("requests are spaced at least the minimum interval apart", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  const fetcher = withSecFairAccess(async () => {
    starts.push(clock.now());
    clock.advance(20); // a fast response
    return secFetched({});
  }, { minIntervalMs: 150, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 3; i += 1) await fetcher(`/api/${i}`);

  assert.deepEqual(starts, [0, 150, 300]);
});

test("concurrent requests queue behind each other instead of starting together", async () => {
  const waits: number[] = [];
  const fetcher = withSecFairAccess(async () => secFetched({}), {
    minIntervalMs: 150,
    now: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await Promise.all([fetcher("/a"), fetcher("/b"), fetcher("/c")]);
  assert.deepEqual(waits, [150, 300]);
});

test("a 429 is retried with exponential backoff, then succeeds", async () => {
  const clock = fakeClock();
  let calls = 0;
  const fetcher = withSecFairAccess(async () => {
    calls += 1;
    if (calls <= 2) throw new SecEdgarFetchError(429, "sec_edgar: HTTP 429");
    return secFetched({ ok: true });
  }, { minIntervalMs: 0, retries: 3, backoffMs: 1000, now: clock.now, sleep: clock.sleep });

  assert.deepEqual((await fetcher("/api/x")).json, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
});

test("a 429 past the retries, or any other failure, is thrown", async () => {
  const clock = fakeClock();
  let calls = 0;
  const limited = withSecFairAccess(async () => {
    calls += 1;
    throw new SecEdgarFetchError(429, "sec_edgar: HTTP 429");
  }, { minIntervalMs: 0, retries: 2, backoffMs: 10, now: clock.now, sleep: clock.sleep });
  await assert.rejects(() => limited("/api/x"), (error) => error instanceof SecEdgarFetchError && error.status === 429);
  assert.equal(calls, 3);

  let notFound = 0;
  const missing = withSecFairAccess(async () => {
    notFound += 1;
    throw new SecEdgarFetchError(404, "sec_edgar: HTTP 404");
  }, { minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
  await assert.rejects(() => missing("/api/y"), (error) => error instanceof SecEdgarFetchError && error.status === 404);
  assert.equal(notFound, 1);
});
