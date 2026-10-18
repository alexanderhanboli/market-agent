import test from "node:test";
import assert from "node:assert/strict";
import { isUuid, stableUuid } from "../src/chat-ids.ts";

test("isUuid accepts any version and variant in either case", () => {
  assert.equal(isUuid("3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c"), true);
  assert.equal(isUuid("3F2B8C1E-9A4D-4E7B-8C21-0D5E6F7A8B9C"), true);
  assert.equal(isUuid("00000000-0000-0000-0000-000000000000"), true);
  assert.equal(isUuid(stableUuid("seed")), true);
});

test("isUuid rejects malformed ids", () => {
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9"), false);
  assert.equal(isUuid("3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c0"), false);
  assert.equal(isUuid("3f2b8c1e9a4d4e7b8c210d5e6f7a8b9c"), false);
  assert.equal(isUuid("3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9g"), false);
  assert.equal(isUuid(" 3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c"), false);
  assert.equal(isUuid("3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c\n"), false);
});
