import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { bootstrapDatabase, connectedClient } from "../../../db/test/docker-pg.ts";
import { loadEvidenceInspection, type EvidenceInspectionRef } from "../src/inspector.ts";
import type { QueryExecutor } from "../src/types.ts";

test("a chat owner inspects a sealed series ref against the real schema; a stranger and an unsealed ref cannot", async (t) => {
  const { databaseUrl } = await bootstrapDatabase(t, "evidence-inspect-series");
  const client = await connectedClient(t, databaseUrl);
  const db = client as unknown as QueryExecutor;

  const [ownerId, strangerId, issuerId, instrumentId, listingId, sourceId, snapshotId, threadId, seriesRef] =
    Array.from({ length: 9 }, () => randomUUID());

  await db.query(`insert into users (user_id, email) values ($1,$2),($3,$4)`, [
    ownerId, `${ownerId}@t.dev`, strangerId, `${strangerId}@t.dev`,
  ]);
  await db.query(
    `insert into sources (source_id, provider, kind, canonical_url, trust_tier, license_class, retrieved_at)
     values ($1,'polygon','market_data','https://polygon.io/','secondary','licensed',now())`,
    [sourceId],
  );
  await db.query(`insert into issuers (issuer_id, legal_name) values ($1,'NVIDIA Corporation')`, [issuerId]);
  await db.query(`insert into instruments (instrument_id, issuer_id, asset_type) values ($1,$2,'common_stock')`, [instrumentId, issuerId]);
  await db.query(
    `insert into listings (listing_id, instrument_id, mic, ticker, trading_currency, timezone)
     values ($1,$2,'XNAS','NVDA','USD','America/New_York')`,
    [listingId, instrumentId],
  );
  const spec = {
    series_ref: seriesRef,
    source_id: sourceId,
    listing_id: listingId,
    bar_range_id: randomUUID(),
    bars_sha256: "3f9a1c0e7b2d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789ab",
    interval: "1d",
    adjustment_basis: "split_adjusted",
    normalization: "pct_return",
    points: "perf_lines",
    delay_class: "eod",
    range: { start: "2025-10-01T00:00:00.000Z", end: "2026-10-15T00:00:00.000Z" },
    window: { kind: "ytd", year: 2026, baseline_date: "2025-12-31", end_date: "2026-10-15" },
    as_of: "2026-10-15T20:00:00.000Z",
  };
  await db.query(
    `insert into snapshots (snapshot_id, subject_refs, source_ids, series_specs, as_of, basis, normalization, allowed_transforms)
     values ($1, $2::jsonb, $3::jsonb, $4::jsonb, now(), 'split_adjusted', 'pct_return', '{}'::jsonb)`,
    [snapshotId, JSON.stringify([{ kind: "listing", id: listingId }]), JSON.stringify([sourceId]), JSON.stringify([spec])],
  );
  await db.query(`insert into chat_threads (thread_id, user_id) values ($1,$2)`, [threadId, ownerId]);
  await db.query(
    `insert into chat_messages (thread_id, role, snapshot_id, blocks, content_hash)
     values ($1::uuid, 'assistant', $2::uuid, '[]'::jsonb, 'h')`,
    [threadId, snapshotId],
  );

  const ref: EvidenceInspectionRef = { kind: "series", id: seriesRef };
  const inspection = await loadEvidenceInspection(db, { user_id: ownerId, snapshot_id: snapshotId, ref });
  assert.equal(inspection.title, "NVDA price series");
  assert.equal(inspection.subtitle, "NVIDIA Corporation");
  assert.deepEqual(inspection.related_refs, [{ kind: "source", id: sourceId }]);
  assert.deepEqual(inspection.links, [{ label: "Open source", href: "https://polygon.io/" }]);

  await assert.rejects(
    () => loadEvidenceInspection(db, { user_id: strangerId, snapshot_id: snapshotId, ref }),
    /snapshot is not visible/,
  );
  await assert.rejects(
    () => loadEvidenceInspection(db, { user_id: ownerId, snapshot_id: snapshotId, ref: { kind: "series", id: randomUUID() } }),
    /ref is not present in snapshot manifest/,
  );
});
