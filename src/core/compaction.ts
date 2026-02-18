// Context compaction — summarises old messages when context gets too full

import type { ModelPlugin, SessionMessage } from '../types.js'
import { createLogger } from './logger.js'
import type { createSessionManager } from './sessions.js'

const log = createLogger('compaction')

/** Estimate token count from text (chars / 4) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Sum actual character content across messages */
export function estimateMessagesChars(messages: SessionMessage[]): number {
  return messages.reduce((sum, m) => {
    let chars = m.content.length
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length
    return sum + chars
  }, 0)
}

export async function compactSession(opts: {
  sessionManager: ReturnType<typeof createSessionManager>
  model: ModelPlugin
  sessionId: string
  targetTokens: number
}): Promise<{ removed: number; summaryTokens: number }> {
  const { sessionManager, model, sessionId, targetTokens } = opts

  const history = sessionManager.getHistory(sessionId)
  if (history.length < 4) return { removed: 0, summaryTokens: 0 }

  const totalChars = estimateMessagesChars(history)
  const totalTokens = Math.ceil(totalChars / 4)

  if (totalTokens <= targetTokens) return { removed: 0, summaryTokens: 0 }

  // Keep the most recent ~30% of messages, compact the rest
  const keepCount = Math.max(2, Math.ceil(history.length * 0.3))
  const toCompact = history.slice(0, history.length - keepCount)
  const toKeep = history.slice(history.length - keepCount)

  if (toCompact.length < 2) return { removed: 0, summaryTokens: 0 }

  log.info('Compacting session', {
    sessionId,
    totalMessages: history.length,
    compacting: toCompact.length,
    keeping: toKeep.length,
  })

  // Build summary prompt
  const conversationText = toCompact
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${m.content.slice(0, 2000)}`)
    .join('\n\n')

  const summaryMessages: SessionMessage[] = [
    {
      role: 'user',
      content: `Summarize this conversation history concisely, preserving key facts, decisions, and context. Output only the summary, no preamble.\n\n${conversationText}`,
    },
  ]

  const response = await model.complete(summaryMessages)
  const summary = response.content

  // Prune old messages and insert summary
  // We prune all but keepCount, then prepend the summary as first message
  const pruned = sessionManager.pruneSession(sessionId, keepCount)
  sessionManager.addMessage(sessionId, 'system', `[Compacted conversation summary]\n${summary}`)

  const summaryTokens = Math.ceil(summary.length / 4)
  log.info('Compaction complete', { removed: pruned, summaryTokens })

  return { removed: pruned, summaryTokens }
}
