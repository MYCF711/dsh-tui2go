import assert from 'node:assert/strict'
import test from 'node:test'
import { dshdServeArgs } from '../../src/backend.js'

const HOME = 'C:/tmp/dsh-go-home'

/** Index of `--flag`'s value in an argv array, or -1 when the flag is absent. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at < 0 ? undefined : args[at + 1]
}

test('dshd serve argv: base shape is serve + home + ephemeral addr', () => {
  const args = dshdServeArgs(HOME, {})

  assert.equal(args[0], 'serve')
  assert.equal(valueOf(args, '--home'), HOME)
  assert.equal(valueOf(args, '--addr'), '127.0.0.1:0')
})

test('dshd serve argv: an unset DSH_GO_POLICY passes no --policy at all', () => {
  const args = dshdServeArgs(HOME, {})

  // The host owns the product default (cmd/dshd/serve.go: `allow`, full
  // permissions as the user asked on 2026-11-04). A plugin-level fallback
  // would silently override it — that regression is what t12 fixes.
  assert.equal(args.includes('--policy'), false, `argv must not pin a policy: ${args.join(' ')}`)
  assert.equal(args.includes('ask'), false, 'the old "ask" fallback must be gone from argv')
  assert.equal(args.includes('allow'), false, 'the plugin must not restate the host default either')
})

test('dshd serve argv: an empty or blank DSH_GO_POLICY counts as unset', () => {
  for (const blank of ['', '   ', '\t']) {
    const args = dshdServeArgs(HOME, { DSH_GO_POLICY: blank })
    assert.equal(args.includes('--policy'), false, `blank policy ${JSON.stringify(blank)} must not pin one`)
  }
})

test('dshd serve argv: an explicit DSH_GO_POLICY is passed through verbatim', () => {
  for (const policy of ['deny', 'ask', 'allow']) {
    const args = dshdServeArgs(HOME, { DSH_GO_POLICY: policy })
    assert.equal(valueOf(args, '--policy'), policy, `explicit ${policy} must reach dshd`)
  }
})

test('dshd serve argv: surrounding whitespace is trimmed before it reaches dshd', () => {
  const args = dshdServeArgs(HOME, { DSH_GO_POLICY: '  deny  ' })

  assert.equal(valueOf(args, '--policy'), 'deny')
})

test('dshd serve argv: an unsupported DSH_GO_POLICY is refused, never silently coerced', () => {
  assert.throws(
    () => dshdServeArgs(HOME, { DSH_GO_POLICY: 'yolo' }),
    /dsh-go: unsupported DSH_GO_POLICY "yolo"/u,
  )
})

test('dshd serve argv: --model is still appended, and only when set', () => {
  assert.equal(dshdServeArgs(HOME, {}).includes('--model'), false)
  assert.equal(dshdServeArgs(HOME, { DSH_GO_MODEL: '  ' }).includes('--model'), false)

  const args = dshdServeArgs(HOME, { DSH_GO_MODEL: 'group/deepseek-v4.1-flash-1017' })
  assert.equal(valueOf(args, '--model'), 'group/deepseek-v4.1-flash-1017')
})

test('dshd serve argv: policy and model compose without reordering the base', () => {
  const args = dshdServeArgs(HOME, { DSH_GO_POLICY: 'deny', DSH_GO_MODEL: 'group/m' })

  assert.deepEqual(args, [
    'serve',
    '--home',
    HOME,
    '--addr',
    '127.0.0.1:0',
    '--policy',
    'deny',
    '--model',
    'group/m',
  ])
})
