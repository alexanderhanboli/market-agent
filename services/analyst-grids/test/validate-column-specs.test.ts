import test from "node:test";
import assert from "node:assert/strict";
import { validateColumnSpecs, READER_QUESTION_COLUMN_KEY } from "../src/column-catalog.ts";
import { GridValidationError } from "../src/types.ts";

const q = (prompt: unknown) => ({ column_key: READER_QUESTION_COLUMN_KEY, params: { prompt } });

test("accepts a deterministic column and a valid question column", () => {
  validateColumnSpecs([{ column_key: "latest_market_cap" }, q("Any China exposure flagged in risk factors?")]);
});

test("rejects unknown column keys", () => {
  assert.throws(() => validateColumnSpecs([{ column_key: "nope" }]), GridValidationError);
});

test("rejects a question column without params.prompt", () => {
  assert.throws(() => validateColumnSpecs([{ column_key: READER_QUESTION_COLUMN_KEY }]), GridValidationError);
  assert.throws(() => validateColumnSpecs([q(42)]), GridValidationError);
});

test("rejects prompts shorter than 8 or longer than 300 chars", () => {
  assert.throws(() => validateColumnSpecs([q("short")]), GridValidationError);
  assert.throws(() => validateColumnSpecs([q("x".repeat(301))]), GridValidationError);
  validateColumnSpecs([q("x".repeat(300))]); // boundary ok
});

test("rejects more than 3 reader columns per grid", () => {
  const four = [q("question one ok"), q("question two ok"), q("question three ok"), q("question four ok")];
  assert.throws(() => validateColumnSpecs(four), GridValidationError);
  validateColumnSpecs(four.slice(0, 3));
});

const CASH_RESILIENCE = [
  "latest_operating_cash_flow", "latest_net_income", "latest_total_liabilities", "latest_total_assets", "latest_total_equity",
  "latest_cash_conversion", "latest_liabilities_to_assets", "latest_liabilities_to_equity",
].map((column_key) => ({ column_key }));
const RATIOS = ["latest_cash_conversion", "latest_liabilities_to_assets", "latest_liabilities_to_equity"];
const revenue = (params?: Record<string, unknown>) => ({ column_key: "latest_revenue", ...(params ? { params } : {}) });

test("rejects numerical columns whose run plan would exceed the operation limit at the row cap (#346)", () => {
  validateColumnSpecs(CASH_RESILIENCE); // 25 rows × 14 operations = 350
  const priorYearRatios = RATIOS.map((column_key) => ({ column_key, params: { offset: 1 } }));
  assert.throws(
    () => validateColumnSpecs([...CASH_RESILIENCE, ...priorYearRatios]),
    { name: "GridValidationError", message: "numerical columns need 575 operations for 25 rows; a grid run allows 512" },
  );
  validateColumnSpecs(Array.from({ length: 20 }, () => revenue())); // 500
  assert.throws(() => validateColumnSpecs(Array.from({ length: 21 }, () => revenue())), /need 525 operations for 25 rows; a grid run allows 512/);
});
