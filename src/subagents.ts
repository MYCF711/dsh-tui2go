import type { SessionCapabilities } from './types/agent/capabilities.js'
import type { AgentEvent } from './types/agent/events.js'
import { createDshGoSubagentEventTranslator } from './task-events.js'

/**
 * Roster events for DSH-GO's synchronous subagent/subagent_fork tools. The
 * delegating callId is the only real identity the host exposes; no independent
 * child session, transcript, messaging route or interrupt success is invented.
 */
export function createDshGoSubagents() {
  const translator = createDshGoSubagentEventTranslator()
  const listeners = new Set<(events: readonly AgentEvent[]) => void>()
  let disposed = false

  const capability: NonNullable<SessionCapabilities['subagents']> = {
    // A synchronous child has no independent Transport control. Cancelling its
    // parent turn would not be an interrupt of only this agent, so report false.
    interrupt: () => Promise.resolve(false),
  }

  return {
    capability,
    /** Feed the translator's own real tool.call/tool.result AgentEvent stream. */
    acceptEvent(event: AgentEvent): readonly AgentEvent[] {
      if (disposed) return []
      const events = translator.accept(event)
      if (events.length > 0) for (const listener of [...listeners]) listener(events)
      return events
    },
    subscribe(listener: (events: readonly AgentEvent[]) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset(): void { translator.reset() },
    dispose(): void {
      if (disposed) return
      disposed = true
      translator.reset()
      listeners.clear()
    },
  }
}
