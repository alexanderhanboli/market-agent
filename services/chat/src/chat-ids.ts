// Deterministic identifiers and content hashes for chat turns, messages, and
// blocks, so a retried turn addresses the same rows.

import { createHash } from "node:crypto";

export function contentHashForText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The one assistant message a turn saves, so a read of the thread can tell
 * that a turn's answer is saved before the turn ends.
 */
export function answerMessageId(threadId: string, turnId: string): string {
  return stableUuid(`financial-message:${threadId}:${turnId}`);
}

/**
 * The financial lane's published answer. It differs from answerMessageId,
 * which an in-progress notice of the same turn may already hold.
 */
export function financialMessageId(threadId: string, turnId: string): string {
  return stableUuid(`financial-message:${threadId}:${turnId}`);
}

export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
