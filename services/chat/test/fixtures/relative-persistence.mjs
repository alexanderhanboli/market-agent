// Loaded by dev-server.test.ts through CHAT_PERSISTENCE_MODULE as a relative path.
// Resolves to a saved message, as the coordinator's persistence hook must.
export async function persistAssistantMessage({ threadId }) {
  return {
    message_id: "fixture-message",
    thread_id: threadId,
    role: "assistant",
    snapshot_id: "fixture-snapshot",
    blocks: [],
    content_hash: "sha256:fixture",
    created_at: "2026-05-06T00:00:00.000Z",
    answered_by: null,
    block_proofs: {},
  };
}
