import type { BlockProof } from '../blocks/blockProof.ts'
import type { Block } from '../blocks/types.ts'

export const CHAT_ROLES = ['user', 'assistant', 'tool'] as const
export type ChatRole = (typeof CHAT_ROLES)[number]

// Frontend mirror of services/chat/src/messages.ts ChatMessageRow. Reuse the
// backend-supplied content_hash as the React key so identical message diffs
// preserve component identity.
export type ChatMessage = {
  message_id: string
  thread_id: string
  role: ChatRole
  snapshot_id: string
  blocks: ReadonlyArray<Block>
  content_hash: string
  created_at: string
  // Each block's evidence, calculation, and public-time claims, derived by the
  // server on read (#193). Absent on messages that were not read back.
  block_proofs?: Readonly<Record<string, BlockProof>>
}

export type SealedChatMessage = ChatMessage & {
  role: 'assistant'
  block_proofs: Readonly<Record<string, BlockProof>>
}

const PROOF_VALUES: { readonly [K in keyof BlockProof]: ReadonlyArray<BlockProof[K]> } = {
  evidence: ['linked', 'unknown'],
  calculation: ['verified', 'not_verified'],
  public_by_cutoff: ['proven', 'unknown'],
}

// Checks the envelope at the stream boundary: the ids the event names, the
// row's string fields, a block id and kind per block, and every proof value.
// Block bodies are left to BlockView, as on the history path.
export function parseSealedMessage(value: unknown, expected: { threadId: string; messageId: unknown }): SealedChatMessage | null {
  if (!isRecord(value)) return null
  const { message_id, thread_id, role, snapshot_id, content_hash, created_at, blocks, block_proofs } = value
  if (message_id !== expected.messageId || thread_id !== expected.threadId || role !== 'assistant') return null
  if (![message_id, snapshot_id, content_hash, created_at].every((field) => typeof field === 'string' && field !== '')) return null
  if (!Array.isArray(blocks) || !blocks.every((block) => isRecord(block) && typeof block.id === 'string' && typeof block.kind === 'string')) return null
  if (!isRecord(block_proofs) || !Object.values(block_proofs).every(isBlockProof)) return null
  return value as SealedChatMessage
}

function isBlockProof(value: unknown): value is BlockProof {
  return isRecord(value) && (Object.keys(PROOF_VALUES) as Array<keyof BlockProof>)
    .every((claim) => (PROOF_VALUES[claim] as ReadonlyArray<unknown>).includes(value[claim]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
