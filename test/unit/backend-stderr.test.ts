import assert from 'node:assert/strict'
import test from 'node:test'
import { forwardDshdStderr, isDshdInfoLine } from '../../src/backend.ts'

test('dshd tool-table and policy announcements are info, not red stderr', () => {
  for (const line of [
    '工具表：compact',
    '工具表：full',
    '工具表：merged',
    '工具表：lazy',
    'policy allow（无人值守，完全权限；要逐次询问请写 --policy ask）；每轮最多 20 步',
    'policy ask（无人值守；审批会转给界面，没人应答就按拒绝处理）；每轮最多 20 步',
    '工具 42 个，12345 字节（形态 compact）',
  ]) assert.equal(isDshdInfoLine(line), true, line)
  const calls: string[] = []
  const host = { debug: (line: string) => calls.push('debug:' + line), stderr: (line: string) => calls.push('stderr:' + line) }
  forwardDshdStderr('工具表：compact', host)
  assert.deepEqual(calls, ['debug:dsh-go: dshd info (工具表：compact)'])
})

test('real dshd errors still reach host.stderr', () => {
  const calls: string[] = []
  const host = { debug: (line: string) => calls.push('debug:' + line), stderr: (line: string) => calls.push('stderr:' + line) }
  for (const line of ['工具表读取失败：boom', 'lazy：会话日志读不出来（boom）', 'write failed']) {
    assert.equal(isDshdInfoLine(line), false, line)
    forwardDshdStderr(line, host)
  }
  assert.deepEqual(calls, ['stderr:工具表读取失败：boom', 'stderr:lazy：会话日志读不出来（boom）', 'stderr:write failed'])
})
