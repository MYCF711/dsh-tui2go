import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SuppressedToolPresentation,
  ToolCallPresentation,
} from '../../src/types/agent/presentation.js'
import { isSuppressedPresentation } from '../../src/presentation.js'

const suppressed = (card: 'question' | 'subagent' | 'todo'): ToolCallPresentation => ({ card })

/** Every structured shape a call can carry; one per `ToolCallView` variant plus decoration. */
const structured: readonly ToolCallPresentation[] = [
  { card: 'generic', title: 'glob' },
  { card: 'terminal', title: 'bash', description: 'run a command', cwd: 'D:/work' },
  { card: 'diff', title: 'edit', diffs: [{ path: 'a.ts', oldText: 'one\n', newText: 'two\n' }] },
  { card: 'generic', title: 'glob', displayKey: 'tool-name-glob', category: 'other' },
]

test('presentation.ts provides a real runtime function, not a declaration borrowed from the vendored .d.ts', () => {
  // A `.d.ts` never emits a `.js`, so importing this name from
  // `./types/agent/presentation.js` typechecks and then dies with
  // ERR_MODULE_NOT_FOUND. This module loading at all is the proof it is real.
  assert.equal(typeof isSuppressedPresentation, 'function')
})

test('the three non-card surfaces are exactly what the guard suppresses', () => {
  for (const card of ['question', 'subagent', 'todo'] as const) {
    const presentation = suppressed(card)
    assert.equal(isSuppressedPresentation(presentation), true, card)
    // The predicate narrows to the *vendored* declaration: this annotation only
    // compiles because both sides are the same SuppressedToolPresentation.
    const narrowed: SuppressedToolPresentation | undefined = isSuppressedPresentation(presentation) ? presentation : undefined
    assert.equal(narrowed?.card, card)
  }
})

test('a structured card is never suppressed, decorated or not', () => {
  for (const presentation of structured) {
    assert.equal(isSuppressedPresentation(presentation), false, presentation.card)
    assert.equal(isSuppressedPresentation({ ...presentation }), false, `${presentation.card} copy`)
  }
})

test('an undefined presentation is not suppressed and does not throw', () => {
  // `tool.call` without a presentation is the common case; the upstream guard
  // checks `!== undefined` before it reads `.card`.
  assert.equal(isSuppressedPresentation(undefined), false)
})

test('suppression is a card-tag test, not "carries a card tag"', () => {
  // A guard written as `presentation.card !== undefined` would suppress every
  // structured tool card; a guard written as `'card' in presentation` would
  // suppress every unknown surface too.
  const future = { card: 'future-surface' } as unknown as ToolCallPresentation
  assert.equal(isSuppressedPresentation(future), false)
  const readResult = { card: 'read', title: 'read file' } as unknown as ToolCallPresentation
  assert.equal(isSuppressedPresentation(readResult), false)
})

test('extra decoration on a suppressed call does not defeat the guard', () => {
  const decorated = { card: 'todo', title: 'ignored', displayKey: 'tool-name-todo_write' } as unknown as ToolCallPresentation
  assert.equal(isSuppressedPresentation(decorated), true)
})

test('the guard answers with a real boolean for every input shape', () => {
  const inputs: readonly (ToolCallPresentation | undefined)[] = [undefined, ...structured, suppressed('question'), suppressed('subagent'), suppressed('todo')]
  for (const input of inputs) {
    assert.equal(typeof isSuppressedPresentation(input), 'boolean')
  }
})
