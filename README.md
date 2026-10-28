# dsh-self-trigger

给 DeepSeek Harness 的**主动性**插件：当宿主空闲到一定程度，由 Agent 自己决定要不要往某个会话里注入一轮。

这个仓库是从 [`dsh-feishu-bridge`](https://github.com/erty3244/dsh-feishu-bridge) 里拆出来的——那边的维护者指出「聊天桥接」和「空闲自触发」是两块不相干的功能，塞在一个包里既不好读也不好配。现在它们各自独立。

## 是什么

- **空闲判定 → 抽签 → 注入一轮**：按 `judgeEveryMinutes` 周期性判定，命中后按 `weights` 抽一个动作（发消息 / 上网看看 / 翻文件 / 什么都不发），然后往 `targetSessionId` 指定的会话里注入一条 `【自触发·自由时间】…` 的提示。
- **交给 Agent 自己决定**：注入只是「给一个机会」，说什么、说不说，由该轮 Agent 按人格与上下文判断。
- **策略现读**：每次判定都重新读 `policy.json`，改参数不用重启宿主。

## 不包含什么

- **不发任何网络请求**。没有 HTTP 客户端、没有长连接。想让它接某个 IM，请另配对应的桥接插件。
- **不管预约提醒**（「下午四点提醒我做某事」那种）。预约任务目前仍留在桥接插件里，后续会迁到独立插件。
- **不碰别的插件的状态文件**。自己的 `state.json` / `usage.json` 只写自己的目录。
- **不替 Agent 写内容**。注入的提示只说明「这次抽到什么、还剩几次、预算多少」。

## 默认值

**装上默认是关闭的**：`policy.json` 不存在时按 `enabled: false` 处理，不会自己开始花 token。要开就在 `policy.json` 里写 `"enabled": true` 并填 `targetSessionId`。

`enabled` 只认布尔 `true`——写成 `"true"` / `"false"` 字符串都当作关闭，避免配置写错时静默开始跑。

## 配置

`policy.json`（默认放在 `~/.dsh/self-trigger/`，可用 `apply(ctx, { stateDir })` 改）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关，只认布尔 `true` |
| `targetSessionId` | `''` | 注入到哪个会话；空 = 不挂牌 |
| `activeFrom` / `activeTo` | `9` / `23.5` | 活跃时段（小时，可用小数） |
| `judgeEveryMinutes` | `60` | 判定周期 |
| `judgeJitterMinutes` | `10` | 判定抖动 |
| `idleMinutes` | `0` | 空闲门槛；`0` = 不看空闲 |
| `dailyMax` | `3` | 每天最多触发几次 |
| `failStepPct` | `10` | 每次落空后概率 +N%，命中归零 |
| `weights` | `{message:40, web:20, files:20, silent:10}` | 动作权重 |
| `budgetPerActivityCny` | `0.3` | 单次活动的预算（仅记账，不阻断） |
| `pricePerMillion` | `{inputHit:0.02,inputMiss:1,output:4}` | 折算单价 |

## 开销

每次真正注入都会让目标会话跑一轮完整的模型调用——**这个插件本身几乎不花 token，花 token 的是被触发的那一轮**。所以：

- 额度上限由 `dailyMax` 与 `budgetPerActivityCny` 控制；
- 没开 `enabled` 时零开销；
- 判定本身是纯计算，不含网络请求。

## 验证

```bash
npm test          # 44 项规则测试 + 8 项插件外壳测试
```

## 安装

```bash
dsh plugin add github:erty3244/dsh-self-trigger
```

装完是关闭状态：编辑 `<stateDir>/policy.json` 填 `enabled: true` 与 `targetSessionId`，再重启宿主（或等下一次判定读新策略）。

## License

MIT
