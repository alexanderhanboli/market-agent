import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapDatabase, connectedClient, dockerAvailable } from "../../../db/test/docker-pg.ts";
import { FACT_METHODS } from "../src/fact-repo.ts";

test("FACT_METHODS lists every method the facts table can hold", { skip: !dockerAvailable(), timeout: 120_000 }, async (t) => {
  const { databaseUrl } = await bootstrapDatabase(t, "fact-method-enum");
  const db = await connectedClient(t, databaseUrl);
  const { rows } = await db.query<{ method: string }>(`select unnest(enum_range(null::fact_method))::text as method`);
  assert.deepEqual([...FACT_METHODS].sort(), rows.map((row) => row.method).sort());
});
