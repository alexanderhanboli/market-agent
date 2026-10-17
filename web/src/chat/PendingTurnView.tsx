import type { ReactElement, ReactNode } from 'react'

import { BlockView } from '../blocks/BlockView.tsx'
import { AgentPlanPanel } from './AgentPlanPanel.tsx'
import type { TurnState } from './chatSession.ts'
import { StreamingBlockView } from './StreamingBlockView.tsx'
import type { StreamState, UnverifiedTurn } from './streamReducer.ts'
import { AssistantTurn, BlockColumn, USER_BUBBLE_CLASS } from './turnLayout.tsx'

type PendingTurnViewProps = {
  turn: TurnState
  backgroundRun: boolean
  onRetry: () => void
  onReload: () => void
  onAsk: (text: string) => boolean
}

const ACTION_BUTTON_CLASS = 'rounded-md border border-negative px-3 py-1.5 text-xs font-medium text-negative'

// The turn that is not yet in the thread's history. Streaming and failed
// render through one tree, so React keeps the answer's DOM nodes until the
// completion commit replaces them with the sealed MessageItem.
export function PendingTurnView({ turn, backgroundRun, onRetry, onReload, onAsk }: PendingTurnViewProps): ReactElement | null {
  switch (turn.phase) {
    case 'idle':
      return backgroundRun ? (
        <p data-testid="background-run" aria-live="polite" className="py-2 text-sm text-muted">
          The analyst is still answering this question.
        </p>
      ) : null
    case 'persisting':
      return (
        <div data-testid="pending-turn" className="flex flex-col gap-2 py-2">
          <OptimisticUserBubble text={turn.turn.text} />
          <p className="text-sm text-muted">Starting…</p>
        </div>
      )
    case 'not_sent':
      return (
        <div data-testid="pending-turn" className="flex flex-col gap-2 py-2">
          <OptimisticUserBubble text={turn.text} />
          <div className="flex items-center gap-3 text-sm">
            <p className="text-negative">Message save failed: {turn.error}</p>
            <button type="button" onClick={() => onAsk(turn.text)} className={ACTION_BUTTON_CLASS}>
              Send again
            </button>
          </div>
        </div>
      )
    case 'unverified':
      return turn.stream.unverified ? <UnverifiedTurnView state={turn.stream} unverified={turn.stream.unverified} /> : null
    case 'streaming':
      return <StreamedTurn phase={turn.phase} stream={turn.stream} />
    case 'failed':
      return (
        <StreamedTurn phase={turn.phase} stream={turn.stream}>
          {turn.recovery === 'retry_stream'
            ? <TurnNotice message={turn.error} action="Retry stream" onAction={onRetry} />
            : <TurnNotice message={turn.error} action="Reload thread" onAction={onReload} />}
        </StreamedTurn>
      )
  }
}

function StreamedTurn({ phase, stream, children }: { phase: TurnState['phase']; stream: StreamState; children?: ReactNode }): ReactElement {
  return (
    <div
      data-testid="streaming-turn"
      data-turn-status={phase}
      aria-live="polite"
      className="flex w-full flex-col gap-3 py-2"
    >
      <AgentPlanPanel steps={stream.plan_steps} />
      <AssistantTurn className="w-full">
        {stream.block_order.map((block_id) => {
          const block = stream.blocks_by_id.get(block_id)
          if (block === undefined) return null
          return (
            <BlockColumn key={block_id} kind={block.kind}>
              <StreamingBlockView block={block} />
            </BlockColumn>
          )
        })}
      </AssistantTurn>
      {children}
    </div>
  )
}

function TurnNotice({ message, action, onAction }: { message: string; action: string; onAction: () => void }): ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm">
      <p className="text-negative">{message}</p>
      <button type="button" onClick={onAction} className={ACTION_BUTTON_CLASS}>
        {action}
      </button>
    </div>
  )
}

function OptimisticUserBubble({ text }: { text: string }): ReactElement {
  return (
    <div data-role="pending-user" className="flex flex-col items-end">
      <div className={USER_BUBBLE_CLASS}>
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      </div>
    </div>
  )
}

function UnverifiedTurnView({ state, unverified }: { state: StreamState; unverified: UnverifiedTurn }): ReactElement {
  return (
    <div data-testid="streaming-turn" data-turn-status="unverified" className="flex w-full flex-col gap-3">
      <AgentPlanPanel steps={state.plan_steps} />
      <div className="rounded border border-negative/40 bg-negative-soft px-3 py-2 text-sm text-negative">
        <p>This answer failed verification and was not saved. It is shown because development mode displays unverified answers.</p>
        <details data-testid="unverified-reasons" className="mt-1">
          <summary className="cursor-pointer text-xs font-medium">Why unverified</summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {unverified.failures.map((failure, index) => (
              <li key={index}>
                {String(failure.reason_code ?? 'unknown')}
                {failure.details ? ` ${JSON.stringify(failure.details)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <AssistantTurn className="w-full">
        {unverified.blocks.map((block) => (
          <BlockColumn key={block.id} kind={block.kind}>
            <BlockView block={block} verification="unverified" />
          </BlockColumn>
        ))}
      </AssistantTurn>
    </div>
  )
}
