import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackendId } from '../../src/types/agent/backend-manifest.js'
import { BACKEND_ID_PATTERN, isBackendIdSyntax } from '../../src/backend-manifest.js'

test('backend-manifest.ts provides real runtime values, not declarations borrowed from the vendored .d.ts', () => {
  // A `.d.ts` never emits a `.js`, so importing these names from
  // `./types/agent/backend-manifest.js` typechecks and then dies with
  // ERR_MODULE_NOT_FOUND. This module loading at all is the proof they are real.
  assert.equal(BACKEND_ID_PATTERN instanceof RegExp, true)
  assert.equal(typeof isBackendIdSyntax, 'function')
})

test('the ported pattern is the 0.18 literal and stays stateless across calls', () => {
  // Pinned to the rule 0.18 ships in `src/agent/backend-manifest.ts` (mirrored in
  // `bin/dsh-tui.js`); a "cleaner" rewrite would silently change what may become
  // a ref, a `~/.dsh-tui/backends/<id>/` path or a log line.
  assert.equal(BACKEND_ID_PATTERN.source, '^[a-z0-9][a-z0-9-]{0,31}$')
  assert.equal(BACKEND_ID_PATTERN.flags.includes('u'), true)
  assert.equal(BACKEND_ID_PATTERN.flags.includes('g') || BACKEND_ID_PATTERN.flags.includes('y'), false, 'lastIndex state would make the answer depend on call order')
  // Called twice on the same input: a `g`/`y` pattern answers false the second time.
  for (const [value, expected] of [['claude', true], ['claude', true], ['Claude', false], ['Claude', false]] as const) {
    assert.equal(isBackendIdSyntax(value), expected, value)
  }
  // Trailing-hyphen latitude is part of the shipped rule, not an oversight here.
  assert.equal(isBackendIdSyntax('acp-gemini-'), true)
})

test('accepts the ids the kernel ships, and 32 is the length boundary', () => {
  for (const id of ['dsh', 'claude', 'codex', 'a', '0', 'a1-b2', 'x'.repeat(32)]) {
    assert.equal(isBackendIdSyntax(id), true, id)
  }
  assert.equal(isBackendIdSyntax('x'.repeat(33)), false)
  assert.equal(isBackendIdSyntax(''), false)
})

test('rejects what a session ref, a path or a log must never carry', () => {
  for (const value of [
    '-dsh',            // no leading hyphen
    'Dsh', 'DSH',      // no uppercase
    'dsh go',          // no space
    ' dsh', 'dsh ',    // no padding
    'dsh/go', 'dsh\\go', // no separators: the id becomes a directory name
    'dsh:go',          // `:` is excluded on purpose (Windows drive letters / ADS)
    'dsh.go', 'dsh_go', 'dsh~go',
    'dsh\n', '\ndsh', 'dsh\r', // `$` is end-of-input here, so a trailing newline cannot sneak through
    'dsh\u0000', 'dsh\u200b',  // control / zero-width
    'dsh\u00e9', '后端', '🙂',
  ]) {
    assert.equal(isBackendIdSyntax(value), false, JSON.stringify(value))
  }
})

test('non-string values never pass', () => {
  for (const value of [undefined, null, 0, 1, 32, true, false, {}, [], ['dsh'], Symbol('dsh'), new String('dsh')]) {
    assert.equal(isBackendIdSyntax(value), false, String(value))
  }
})

test('the guard narrows to the vendored BackendId brand', () => {
  // Both annotations use the *vendored* type. They only compile because the
  // predicate narrows to that same branded `BackendId` — a private copy of the
  // `unique symbol` brand in this module would not be assignable here.
  const rejected: BackendId | undefined = isBackendIdSyntax('acp:gemini') ? 'acp:gemini' : undefined
  assert.equal(rejected, undefined)
  const accepted: BackendId | undefined = isBackendIdSyntax('claude') ? 'claude' : undefined
  assert.equal(accepted, 'claude')
})

test('only a string that passed the syntax gate reaches a ref, a path or a log', () => {
  const untrusted: unknown = 'dsh-go'
  assert.equal(isBackendIdSyntax(untrusted) ? untrusted : 'dsh', 'dsh-go')
  const hostile: unknown = 'dsh-go/../../etc'
  assert.equal(isBackendIdSyntax(hostile) ? hostile : 'dsh', 'dsh')
})
