import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BACKEND_ID,
  formatSessionRef,
  parseSessionRef,
  sameSessionRef,
} from '../../src/refs.js'
import type { AgentSessionRef } from '../../src/types/agent/refs.js'

const KNOWN = ['dsh', 'claude', 'acp:gemini', 'acp'] as const

test('refs.ts provides real runtime values, not declarations borrowed from the vendored .d.ts', () => {
  // A `.d.ts` never emits a `.js`, so importing these names from
  // `./types/agent/refs.js` typechecks and then dies with ERR_MODULE_NOT_FOUND.
  // This module loading at all is the proof that the implementation is real.
  assert.equal(typeof DEFAULT_BACKEND_ID, 'string')
  assert.equal(DEFAULT_BACKEND_ID, 'dsh')
  assert.equal(typeof formatSessionRef, 'function')
  assert.equal(typeof parseSessionRef, 'function')
  assert.equal(typeof sameSessionRef, 'function')
})

test('formatSessionRef omits only the default backend prefix, keeping DSH ids valid as-is', () => {
  assert.equal(formatSessionRef({ backendId: 'dsh', sessionId: 'sess-1' }), 'sess-1')
  assert.equal(formatSessionRef({ backendId: 'claude', sessionId: 'u-1' }), 'claude:u-1')
  assert.equal(formatSessionRef({ backendId: 'acp:gemini', sessionId: 'g-1' }), 'acp:gemini:g-1')
  // An empty session id still serializes; parse refuses to read it back as a prefix.
  assert.equal(formatSessionRef({ backendId: 'claude', sessionId: '' }), 'claude:')
})

test('round-trip holds for every known backend and a real session id', () => {
  const sessionIds = ['sess-1', '0199f0c1-4c2f-7c31-9a5b', 'a:b', '甲🙂', '0']
  for (const backendId of KNOWN) {
    for (const sessionId of sessionIds) {
      const ref: AgentSessionRef = { backendId, sessionId }
      const text = formatSessionRef(ref)
      const parsed = parseSessionRef(text, KNOWN)
      assert.deepEqual(parsed, { backendId, sessionId }, `round-trip ${backendId} ${sessionId}`)
      assert.equal(formatSessionRef(parsed), text)
    }
  }
})

test('a bare id is the default backend, and the default prefix is never re-read as one', () => {
  assert.deepEqual(parseSessionRef('sess-1', KNOWN), { backendId: 'dsh', sessionId: 'sess-1' })
  assert.deepEqual(parseSessionRef('sess:1', KNOWN), { backendId: 'dsh', sessionId: 'sess:1' })
  // DSH references are persisted bare; `dsh:<id>` is not one of their spellings.
  assert.deepEqual(parseSessionRef('dsh:sess-1', KNOWN), { backendId: 'dsh', sessionId: 'dsh:sess-1' })
  assert.deepEqual(parseSessionRef('', KNOWN), { backendId: 'dsh', sessionId: '' })
})

test('a colon-bearing backend id is matched as the longest known prefix', () => {
  assert.deepEqual(parseSessionRef('acp:gemini:g-1', KNOWN), { backendId: 'acp:gemini', sessionId: 'g-1' })
  assert.deepEqual(parseSessionRef('acp:g-1', KNOWN), { backendId: 'acp', sessionId: 'g-1' })
  // Known-list order must not decide the winner.
  assert.deepEqual(parseSessionRef('acp:gemini:g-1', ['acp', 'acp:gemini']), { backendId: 'acp:gemini', sessionId: 'g-1' })
  assert.deepEqual(parseSessionRef('acp:gemini:g-1', ['acp:gemini', 'acp']), { backendId: 'acp:gemini', sessionId: 'g-1' })
})

test('unknown, empty and colon-terminated prefixes stay a bare DSH id', () => {
  assert.deepEqual(parseSessionRef('zed:1', KNOWN), { backendId: 'dsh', sessionId: 'zed:1' })
  assert.deepEqual(parseSessionRef('claude:', KNOWN), { backendId: 'dsh', sessionId: 'claude:' })
  assert.deepEqual(parseSessionRef('claude:u-1', []), { backendId: 'dsh', sessionId: 'claude:u-1' })
  assert.deepEqual(parseSessionRef('claude:u-1', ['', 'dsh']), { backendId: 'dsh', sessionId: 'claude:u-1' })
  assert.deepEqual(parseSessionRef('claud:u-1', KNOWN), { backendId: 'dsh', sessionId: 'claud:u-1' })
})

test('sameSessionRef is value equality across both members, not object identity', () => {
  assert.equal(sameSessionRef({ backendId: 'dsh', sessionId: 'a' }, { backendId: 'dsh', sessionId: 'a' }), true)
  assert.equal(sameSessionRef({ backendId: 'claude', sessionId: 'a' }, { backendId: 'claude', sessionId: 'a' }), true)
  assert.equal(sameSessionRef({ backendId: 'dsh', sessionId: 'a' }, { backendId: 'claude', sessionId: 'a' }), false)
  assert.equal(sameSessionRef({ backendId: 'dsh', sessionId: 'a' }, { backendId: 'dsh', sessionId: 'b' }), false)
  assert.equal(sameSessionRef({ backendId: 'acp:gemini', sessionId: 'g' }, { backendId: 'acp', sessionId: 'gemini:g' }), false)
})
