// dsh-self-trigger · 宿主插件入口
//
// 负责：空闲判定 → 按概率与权重抽签 → 往目标会话注入一条【自触发·自由时间】提示；
// 以及到点注入【预约任务】。判定逻辑全在 ./rules.js（纯函数，可离线自测）。
//
// 设计约束（与 dsh-feishu-bridge 拆分时定的）：
//   1. 默认关闭：enabled 默认 false，装上不会自己开始花 token。
//   2. 不碰网络：只依赖宿主的 sessionController，不发任何 HTTP 请求。
//   3. 不碰别人的状态：自己的状态写在自己的 stateDir 里，不读写桥接插件的文件。
//   4. 策略现读：每次判定都重新读 policy 文件，改参数不用重启宿主。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  decideSelfTrigger,
  pickSelfTriggerAction,
  buildSelfTriggerText,
} from './rules.js'

export const name = 'dsh-self-trigger'
export const inject = ['sessionController']

const DEFAULT_POLICY = {
  enabled: false,                 // 默认关闭
  targetSessionId: '',            // 注入到哪个会话；空 = 不挂牌
  activeFrom: 9,
  activeTo: 23.5,
  judgeEveryMinutes: 60,
  judgeJitterMinutes: 10,
  idleMinutes: 0,
  dailyMax: 3,
  failStepPct: 10,
  weights: { message: 40, web: 20, files: 20, silent: 10 },
  actions: ['message', 'web', 'files', 'silent'],
  budgetPerActivityCny: 0.3,
  pricePerMillion: { inputHit: 0.02, inputMiss: 1, output: 4 },
  offFile: '',                    // 非空 = 暂停
}

export function apply(ctx, config = {}) {
  const stateDir = String(config.stateDir ?? join(homedir(), '.dsh', 'self-trigger'))
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  const policyFile = join(stateDir, 'policy.json')
  const stateFile = join(stateDir, 'state.json')
  const usageFile = join(stateDir, 'usage.json')

  const log = (msg) => ctx.logger?.info?.(`[self-trigger] ${msg}`)

  const readPolicy = () => {
    try {
      const raw = JSON.parse(readFileSync(policyFile, 'utf8').replace(/^\uFEFF/, ''))
      const merged = { ...DEFAULT_POLICY, ...raw }
      merged.enabled = merged.enabled === true
      return merged
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`策略文件读取失败，用默认值：${error?.message ?? error}`)
      return { ...DEFAULT_POLICY }
    }
  }

  const readState = () => {
    try {
      return { ...JSON.parse(readFileSync(stateFile, 'utf8')), ...{} }
    } catch {
      return { lastActivityAt: 0, lastTurnEndAt: 0, lastFireAt: 0, day: '', count: 0, silentRun: 0, fails: 0, nextCheckAt: 0 }
    }
  }
  const saveState = (state) => {
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 0))
    } catch (error) {
      log(`状态写入失败：${error?.message ?? error}`)
    }
  }

  let state = readState()
  let timer = null
  let scheduleTimer = null

  // 只把「人说的话」当作活动；插件注入的（selftrigger-* / sched-*）不算。
  const onSessionEvent = (session, event) => {
    const rpcId = String(event?.source?.rpcId ?? '')
    const injected = rpcId.startsWith('selftrigger-') || rpcId.startsWith('sched-')
    if (event?.type === 'turn/end') {
      state.lastTurnEndAt = Date.now()
      saveState(state)
    }
    if (!injected && (event?.type === 'user/message' || event?.type === 'turn/start')) {
      state.lastActivityAt = Date.now()
      saveState(state)
    }
  }

  const fire = async (verdict, policy, now) => {
    const target = String(policy.targetSessionId ?? '').trim()
    if (target === '') return
    const requestId = `selftrigger-${now}`
    const text = buildSelfTriggerText({
      idleHours: ((now - Number(state.lastActivityAt ?? 0)) / 3600000).toFixed(1),
      nowText: new Date(now).toLocaleString('zh-CN', { hour12: false }),
      todayCount: Number(state.count ?? 0) + 1,
      dailyMax: Number(policy.dailyMax ?? 3),
      pick: verdict.pick,
      budgetCny: policy.budgetPerActivityCny,
      reason: verdict.reason,
    })
    state.count = Number(state.count ?? 0) + 1
    state.lastFireAt = now
    saveState(state)
    try {
      await ctx.sessionController.prompt({ sessionId: target, text, requestId })
      log(`已注入（${verdict.reason}，今天第 ${state.count}/${policy.dailyMax} 次）`)
    } catch (error) {
      state.count = Math.max(0, Number(state.count ?? 0) - 1)
      saveState(state)
      log(`注入失败，已撤回次数：${error?.message ?? error}`)
    }
  }

  const check = () => {
    const policy = readPolicy()
    if (!policy.enabled) return
    const now = Date.now()
    if (Number(state.nextCheckAt ?? 0) > now) return
    const day = new Date(now).toISOString().slice(0, 10)
    if (state.day !== day) {
      state = { ...state, day, count: 0, silentRun: 0, fails: 0 }
    }
    const verdict = decideSelfTrigger(state, {
      ...policy,
      hour: new Date(now).getHours() + new Date(now).getMinutes() / 60,
      now,
    })
    state.nextCheckAt = now + Number(policy.judgeEveryMinutes ?? 60) * 60000
    if (!verdict.fire) {
      saveState(state)
      return
    }
    const pick = pickSelfTriggerAction(policy.weights, Math.random())
    state.fails = 0
    if (pick === 'silent') {
      state.count = Number(state.count ?? 0) + 1
      state.silentRun = Number(state.silentRun ?? 0) + 1
      saveState(state)
      log('抽到「什么都不发」，本次保持安静')
      return
    }
    void fire({ ...verdict, pick }, policy, now)
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-self-trigger: 会话事件监听')
  ctx.effect(() => {
    const policy = readPolicy()
    if (!policy.enabled) {
      log('未启用（policy.enabled=false）；写 policy.json 的 enabled:true 后再重启或等下一次判定')
      return () => {}
    }
    timer = setInterval(check, 60000)
    log(`已挂牌：每 ${policy.judgeEveryMinutes} 分钟判定一次，目标会话 ${policy.targetSessionId || '未设置'}`)
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }, 'dsh-self-trigger: 判定计时器')

}
