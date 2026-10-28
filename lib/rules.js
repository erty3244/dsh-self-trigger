// dsh-self-trigger · 纯规则层
// 从 dsh-feishu-bridge 拆出：自触发/预约任务的判定逻辑做成纯函数，
// 不碰 ctx、不碰时钟、随机数与当前时间都由调用方传入，便于离线自测。
// 自触发注入的提示文本（纯函数，可离线自测）：把"这次抽到什么、还剩几次、预算多少"讲清楚。
export function buildSelfTriggerText(input) {
  const idleHours = Number(input?.idleHours ?? 0).toFixed(1)
  const labels = {
    web: '上网看看：web_search / web_fetch，只去公开网站，不登录、不付费',
    files: '翻他电脑里的文件：只读；不碰凭据文件与 .dsh 目录',
    message: '给博士发点什么：把话直接写出来，会原样送到他的飞书'
  }
  const pick = String(input?.pick ?? 'web')
  const focus = labels[pick] ?? '什么都不做'
  const others = [labels.web, labels.files, labels.message].filter((line, i) => ['web', 'files', 'message'][i] !== pick)
  const tail = String(input?.tail ?? '')
  return [
    `【自触发·自由时间】已经空闲 ${idleHours} 小时（现在 ${input?.nowText ?? ''}）。`,
    `这次机会用完，今天还剩 ${Number(input?.remaining ?? 0)} 次（上限 ${Number(input?.dailyMax ?? 0)} 次）。`,
    `骰子这次给你的是：${focus}。先把这件事做了；下面这些顺手可做可不做：`,
    ...others.map((line) => `· ${line}`),
    '做什么、做多少都由你定；也可以什么都不做、保持沉默——沉默不需要理由，也不是失职，不想说就什么都不要产出。',
    '后两件事做完，可以说说你看见了什么（也可以不说）。',
    `预算：本次活动折合不超过 ¥${Number(input?.budgetCny ?? 0.3).toFixed(3)}（含你的思考与工具调用），超了插件会直接掐断这一轮；请节约。`,
    tail === '' ? '' : `\n（上一段对话的尾巴，供你判断有没有值得接的话）\n${tail}`
  ].filter((line) => line !== '').join('\n')
}

// 时间格式化小工具（与桥接插件里的实现保持一致）
const fmtDur = (ms) => (ms >= 3600000 ? `${ms / 3600000}h` : ms >= 60000 ? `${Math.round(ms / 60000)}min` : `${Math.round(ms / 1000)}s`)
const fmtClock = (hour) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`
// 自触发的判定逻辑：做成纯函数，好离线自测（不碰 ctx、不碰时钟、随机数由外面传进来）。
// 返回 judge=false 表示"这次不判定"（暂停累计失败）：不在活跃时段 / 今天到顶 / 连续沉默到顶；
// conf.idleMs > 0 时才额外要求"空闲够久"（2026-10-22 11:08 起默认 0，即不看空闲）。
// judge=true 时 p = 已连续落空次数 × failStepPct，rnd < p 即命中。
export function shouldDeferJudge(input) {
  const pending = Number(input?.pendingUserMsgs ?? 0)
  if (pending > 0) return '他发的消息还没回完'
  const quiet = Math.max(0, Number(input?.quietMs ?? 0))
  const since = Number(input?.sinceTurnEndMs ?? Number.POSITIVE_INFINITY)
  if (since < quiet) return '上一轮刚结束不久'
  return ''
}

export function decideSelfTrigger(state, conf) {
  const paused = (reason) => ({ judge: false, fire: false, p: 0, reason })
  if (!(Number(state?.lastActivityAt ?? 0) > 0)) {
    return paused('还没有活动时间基线（首次运行 / 刚重启），先不计空闲')
  }
  if (conf.hour < conf.activeFrom || conf.hour >= conf.activeTo) {
    return paused(`非活跃时段（${fmtClock(conf.hour)} 不在 ${fmtClock(conf.activeFrom)}–${fmtClock(conf.activeTo)}）`)
  }
  const idle = conf.now - Number(state.lastActivityAt)
  const idleGated = Number(conf.idleMs ?? 0) > 0
  if (idleGated && !(idle >= conf.idleMs)) {
    return paused(`博士还在（空闲 ${(idle / 3600000).toFixed(1)}h < ${(conf.idleMs / 3600000).toFixed(1)}h），这一轮不累计`)
  }
  if (Number(state?.count ?? 0) >= conf.dailyMax) {
    return paused(`今天已经触发 ${state.count} 次（上限 ${conf.dailyMax}）`)
  }
  if (Number(state?.silentRun ?? 0) >= conf.silenceStop) {
    return paused(`今天已连续沉默 ${state.silentRun} 次，不再打扰`)
  }
  const fails = Math.max(0, Number(state?.fails ?? 0))
  const p = Math.min(1, (fails * Number(conf.failStepPct ?? 10)) / 100)
  const fire = Number(conf.rnd ?? 0) < p
  return {
    judge: true,
    fire,
    p,
    reason: fire
      ? `判定命中（p=${(p * 100).toFixed(0)}%，累计落空 ${fails} 次${idleGated ? `，空闲 ${(idle / 3600000).toFixed(1)}h` : ''}）`
      : `判定未中（p=${(p * 100).toFixed(0)}%${idleGated ? `，空闲 ${(idle / 3600000).toFixed(1)}h` : ''}）`
  }
}

// 命中之后抽"这次做什么"：按权重抽签，权重全 0 时退回"什么都不发"。
export function pickSelfTriggerAction(weights, rnd) {
  const keys = ['web', 'files', 'message', 'nothing']
  const list = keys.map((key) => [key, Math.max(0, Number(weights?.[key] ?? 0))])
  const total = list.reduce((sum, [, w]) => sum + w, 0)
  if (!(total > 0)) return 'nothing'
  const r = Math.min(Math.max(Number(rnd ?? 0), 0), 0.999999) * total
  let acc = 0
  for (const [key, w] of list) {
    acc += w
    if (r < acc) return key
  }
  return list[list.length - 1][0]
}

// 预约任务的到点判定（同样是纯函数）：只挑 status=pending 且 dueAt <= now 的，按时间排序。
// fired / done / cancelled 都不再触发；dueAt 缺失或非法的条目一律跳过（宁可漏跑，也不误跑）。
export function pickDueSchedule(items, now) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.status === 'pending' && Number(it.dueAt) > 0 && Number(it.dueAt) <= now)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
}

// 花费折算（纯函数，可离线自测）：token 数 × 单价（元 / 百万 token）。
// 宿主侧的 usage 不变量：total = input + output + cacheRead + cacheWrite，
// 即 inputTokens 是"未命中缓存"的那部分输入；缓存命中的另算（便宜）。
export function costOfUsage(usage, price) {
  return (
    Number(usage?.inputTokens ?? 0) * Number(price?.input ?? 0)
    + Number(usage?.cacheReadTokens ?? 0) * Number(price?.cacheRead ?? 0)
    + Number(usage?.cacheWriteTokens ?? 0) * Number(price?.cacheWrite ?? 0)
    + Number(usage?.outputTokens ?? 0) * Number(price?.output ?? 0)
  ) / 1e6
}

