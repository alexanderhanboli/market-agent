import type { ChatReadMessage } from "../src/messages.ts";

// A persisted assistant message as readChatMessage returns it, for fakes of
// the persistence hook.
export function readMessage(fields: Pick<ChatReadMessage, "message_id" | "snapshot_id"> & Partial<ChatReadMessage>): ChatReadMessage {
  return Object.freeze({
    thread_id: "thread-1",
    role: "assistant",
    blocks: [],
    content_hash: "sha256:fixture",
    created_at: "2026-05-06T00:00:00.000Z",
    answered_by: null,
    block_proofs: {},
    ...fields,
  });
}
