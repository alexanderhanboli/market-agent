// A follow-up to the engine's answer reads the figures it published (#378
// review): the saved scope takes the plan's metrics, with no model call.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dockerAvailable } from "../../../db/test/docker-pg.ts";
import type { PlanningModel } from "../../financial-engine/src/planner.ts";
import { databaseUrl, IDS } from "../../financial-engine/test/db-fixtures.ts";
import { analystTurnScope, closeLocalRuntimePoolForTests, financialResearchScope } from "../src/local-runtime.ts";
import { proposalQuestion } from "../src/scope-proposal.ts";
import type { ChatResolvedSubjectPreResolution, ChatSubjectPreResolution } from "../src/subjects.ts";
import { chatDatabase, chatHarness, completed, resolveMention } from "./financial-fixtures.ts";

const QUESTION = "Why did it change?";

// AAA as the resolver hands it to the analyst path, with its handoff.
async function withHandoff(mention: string): Promise<ChatSubjectPreResolution> {
  const resolution = await resolveMention(mention);
  if (resolution.status !== "resolved") return resolution;
  const handoff = { subject_ref: resolution.subject_ref, context: {}, display_labels: { ticker: mention } };
  return { ...resolution, handoff } as unknown as ChatSubjectPreResolution;
}

const epsModel = (async () => ({
  model: "stub-model",
  text: JSON.stringify({
    outcome: "ready",
    subjects: [{ slot_id: "a", mention: "AAA" }],
    operations: [{ node_id: "a_eps", operation: "reported_metric", subject_slot: "a", metric_key: "eps_diluted", period: { kind: "fiscal_period", fiscal_year: 2023, fiscal_period: "FY" } }],
    outputs: [{ output_id: "a_out", node_id: "a_eps" }],
    thresholds: [],
  }),
})) as unknown as PlanningModel;

test("a follow-up to the engine's EPS answer reads EPS", { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip("Docker is required for the financial follow-up");
    return;
  }
  const { db, pool, threadId } = await chatDatabase(t, "chat-fin-follow-up");
  const replies = join(mkdtempSync(join(tmpdir(), "fin-follow-up-")), "replies.json");
  writeFileSync(replies, JSON.stringify({
    replies: [{ match: proposalQuestion(QUESTION), text: '{"metrics":[],"asks":["explains"],"turns_off":{"facets":[],"metrics":[]},"income_items":[]}' }],
  }));
  Object.assign(process.env, {
    CHAT_DATABASE_URL: databaseUrl(db),
    LLM_CHANNELS: "fixture",
    LLM_FIXTURE_PROTOCOL: "openai",
    LLM_FIXTURE_MODELS: "recorded",
    LITELLM_MODEL: "fixture/recorded",
    LLM_REPLAY_FILE: replies,
  });
  t.after(closeLocalRuntimePoolForTests);

  const harness = chatHarness(pool, { model: epsModel, researchScope: financialResearchScope, resolveMention: withHandoff });
  const answer = completed((await harness.run({ threadId, userId: IDS.owner, userIntent: "What was AAA's EPS?" })).events);
  const saved = (await db.query(`select research_scope from chat_messages where message_id = $1`, [answer.message_id])).rows[0].research_scope;
  assert.deepEqual([saved.reads, saved.metrics], ["financial_answer", [{ metric_key: "eps_diluted", label: "Earnings per share", available: true }]]);

  const aaa = await withHandoff("AAA") as ChatResolvedSubjectPreResolution;
  const scope = (await analystTurnScope(threadId, QUESTION, [aaa]))("2026-09-01T00:00:00.000Z");
  assert.deepEqual(
    { route: scope.route, reads: scope.reads, metrics: scope.metrics.map((metric) => metric.metric_key), explains: scope.explains },
    { route: "statements", reads: "statements", metrics: ["eps_diluted"], explains: true },
  );
});
