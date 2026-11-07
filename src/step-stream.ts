import type { AgentEvent } from './types/agent/events.js'
import type { DshGoServerFrame } from './events.js'

export interface DshGoStepTiming {
  readonly turn: number
  readonly step: number
  readonly startTime?: number
  readonly firstTokenTime?: number
  readonly lastTokenTime?: number
  readonly endTime?: number
  readonly ttftMs?: number
  readonly decodeMs?: number
}

interface StepState {
  readonly turn: number
  readonly step: number
  readonly attemptId: string
  startTime?: number
  firstTokenTime?: number
  lastTokenTime?: number
  endTime?: number
  nextIndex: number
  open: boolean
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const position = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const stamp = (value: unknown): number | undefined => position(value)
const keyOf = (turn: number, step: number): string => `${turn}:${step}`
const supported = new Set(['step/start', 'step/end', 'assistant/text', 'assistant/reasoning'])

/**
 * Translate only real DSH-GO step/text frames. The first content frame opens
 * the projection attempt with its actual timestamp, preserving TTFT instead
 * of pretending that request submission or step/start was the first token.
 */
export function createDshGoStepStreamTranslator() {
  const steps = new Map<string, StepState>()

  const timingOf = (state: StepState): DshGoStepTiming => ({
    turn: state.turn,
    step: state.step,
    ...(state.startTime === undefined ? {} : { startTime: state.startTime }),
    ...(state.firstTokenTime === undefined ? {} : { firstTokenTime: state.firstTokenTime }),
    ...(state.lastTokenTime === undefined ? {} : { lastTokenTime: state.lastTokenTime }),
    ...(state.endTime === undefined ? {} : { endTime: state.endTime }),
    ...(state.startTime === undefined || state.firstTokenTime === undefined
      ? {}
      : { ttftMs: Math.max(0, state.firstTokenTime - state.startTime) }),
    ...(state.firstTokenTime === undefined || state.lastTokenTime === undefined
      ? {}
      : { decodeMs: Math.max(0, state.lastTokenTime - state.firstTokenTime) }),
  })

  const translateFrame = (frame: DshGoServerFrame): readonly AgentEvent[] | undefined => {
    if (!supported.has(frame.type)) return undefined
    const data = rec(frame.data)
    const turn = position(data?.turn)
    const step = position(data?.step)
    if (data === undefined || turn === undefined || step === undefined) return []
    const key = keyOf(turn, step)
    const time = stamp(frame.time)

    if (frame.type === 'step/start') {
      const previous = steps.get(key)
      const attemptId = previous?.attemptId ?? `dsh-go:step:${turn}:${step}`
      steps.set(key, {
        turn,
        step,
        attemptId,
        startTime: time,
        nextIndex: previous?.nextIndex ?? 0,
        open: previous?.open ?? false,
      })
      return [{ type: 'step.start', turn, step }]
    }

    if (frame.type === 'step/end') {
      const state = steps.get(key)
      const out: AgentEvent[] = []
      if (state !== undefined) {
        state.endTime = time
        if (state.open) {
          out.push({ type: 'assistant.attempt.end', attemptId: state.attemptId, outcome: 'committed' })
          state.open = false
        }
      }
      out.push({ type: 'step.end', turn, step })
      return out
    }

    const deltaText = data.text
    if (typeof deltaText !== 'string') return []
    let state = steps.get(key)
    if (state === undefined) {
      state = {
        turn,
        step,
        attemptId: typeof data.attemptId === 'string' && data.attemptId !== '' ? data.attemptId : `dsh-go:step:${turn}:${step}`,
        nextIndex: 0,
        open: false,
      }
      steps.set(key, state)
    }
    const out: AgentEvent[] = []
    if (!state.open) {
      state.firstTokenTime = time
      state.open = true
      out.push({
        type: 'assistant.attempt.start',
        attemptId: state.attemptId,
        turn,
        step,
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(time === undefined ? {} : { firstTokenTime: time }),
      })
    }
    if (time !== undefined) state.lastTokenTime = time
    const suppliedIndex = position(data.index)
    const index = suppliedIndex ?? state.nextIndex
    state.nextIndex = Math.max(state.nextIndex, index + 1)
    const durableSeq = position(data.v4Seq)
    out.push({
      type: 'assistant.delta',
      attemptId: state.attemptId,
      index,
      time: time ?? 0,
      turn,
      step,
      ...(durableSeq === undefined ? {} : { seq: durableSeq }),
      delta: frame.type === 'assistant/text'
        ? { kind: 'text', text: deltaText }
        : { kind: 'reasoning', text: deltaText },
    })
    return out
  }

  return {
    translateFrame,
    timings: (): readonly DshGoStepTiming[] => [...steps.values()].map(timingOf),
    reset: (): void => { steps.clear() },
  }
}

export type DshGoStepStreamTranslator = ReturnType<typeof createDshGoStepStreamTranslator>
