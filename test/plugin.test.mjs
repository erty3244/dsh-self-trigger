// 插件外壳的离线冒烟测试：不连宿主、不联网，只验证「默认关闭 / 开了才挂牌 / 可卸载」。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import { apply, name, inject } from '../lib/index.js'

const makeCtx = () => {
  const logs = []
  const disposers = []
  return {
    logs,
    disposers,
    ctx: {
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      on: () => () => {},
      effect: (fn, desc) => {
        const d = fn()
        disposers.push({ desc, d })
        return d
      },
      sessionController: { prompt: async () => ({ ok: true }) },
    },
  }
}

let passed = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  passed += 1
}

// 1) 元信息
ok(name === 'dsh-self-trigger', '插件名')
ok(inject.includes('sessionController'), '依赖注入声明')

// 2) 默认关闭：没有 policy 文件时不应该挂牌
{
  const dir = mkdtempSync(join(tmpdir(), 'st-disabled-'))
  const { ctx, logs, disposers } = makeCtx()
  apply(ctx, { stateDir: dir })
  ok(logs.some((l) => l.includes('未启用')), '默认关闭时记录「未启用」')
  ok(!logs.some((l) => l.includes('已挂牌')), '默认关闭时不挂牌')
  disposers.forEach(({ d }) => typeof d === 'function' && d())
}

// 3) 显式开启：写 policy.json 后挂牌，并可卸载
{
  const dir = mkdtempSync(join(tmpdir(), 'st-enabled-'))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ enabled: true, targetSessionId: 'session-test', judgeEveryMinutes: 60 }))
  const { ctx, logs, disposers } = makeCtx()
  apply(ctx, { stateDir: dir })
  ok(logs.some((l) => l.includes('已挂牌')), '开启后挂牌')
  ok(logs.some((l) => l.includes('session-test')), '日志里带上目标会话')
  disposers.forEach(({ d }) => typeof d === 'function' && d())
  passed += 1
}

// 4) enabled 只认布尔 true（字符串 "false" 不算开）
{
  const dir = mkdtempSync(join(tmpdir(), 'st-strfalse-'))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ enabled: 'false', targetSessionId: 'x' }))
  const { ctx, logs, disposers } = makeCtx()
  apply(ctx, { stateDir: dir })
  ok(!logs.some((l) => l.includes('已挂牌')), '字符串 "false" 不能当成开启')
  disposers.forEach(({ d }) => typeof d === 'function' && d())
}

console.log(`✅ 插件外壳测试通过：${passed} 项`)
