import type { ChatThread } from './threadActions.ts'

const MAX_QUESTION_NAME_LENGTH = 60

// The header and the active thread row share this, so a thread is never shown
// by its UUID while the server's title job is still running.
export function threadDisplayName(thread: ChatThread | undefined, firstQuestion: string | null): string {
  const title = thread?.title?.trim()
  if (title) return title
  const question = firstQuestion?.replace(/\s+/g, ' ').trim()
  if (question) {
    return question.length > MAX_QUESTION_NAME_LENGTH
      ? `${question.slice(0, MAX_QUESTION_NAME_LENGTH).trimEnd()}…`
      : question
  }
  return 'New chat'
}
