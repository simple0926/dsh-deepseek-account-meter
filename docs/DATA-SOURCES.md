# 数据来源与取舍

这份文档记录插件背后的事实依据，方便审查与后续维护。所有结论都针对 **DSH `0.2.1-rc.5`**（macOS 桌面版）核对过。

## 余额

- 服务：`ctx.deepseekAccount.getBalance(client)`，由 `@deepseek-ai/dsh-deepseek-account-platform` 提供。
- 底层请求：`GET {platformOrigin}/api/v0/users/get_user_summary`，默认 `https://platform.deepseek.com`。
- 入参 `AccountClientMetadata`：

  | 字段 | 说明 |
  |---|---|
  | `version` | 发给 `x-client-version`；DSH 没有暴露应用版本的服务，所以是插件配置项 |
  | `locale` | 主语言子标签决定 `x-client-locale` 为 `zh_CN` 或 `en_US` |
  | `timezoneOffsetSeconds` | `x-client-timezone-offset`，按调用时刻采样 |

- 返回值：

  ```ts
  null                                             // 未登录，或授权在查询期间失效（Host 已撤销）
  | { status: 'failed' }                           // 传输 / 协议 / 结构错误
  | { status: 'ready', value: AccountWallet[],     // 充值钱包
      bonusWallets: AccountWallet[] }              // 赠送钱包
  // AccountWallet = { currency: 'CNY' | 'USD', balance: string }
  ```

- 关键语义：**失败不会变成 0**。HTTP 401 或业务码 40003 时 Host 会删除本地授权并发出
  `deepseek-account/session-expired` 与 `deepseek-account/signed-out`，此时调用返回 `null`。
- Host 侧没有任何缓存；DSH 自带的账号界面也**从不轮询**余额（只在打开页面、登录成功、
  重连、从充值页返回时读一次）。因此插件自己做了 60 秒缓存与失败退避，避免给 Platform 增加压力。

## Token 用量

- 事件来源：`SessionEventMap['assistant/message'].usage?: TokenUsage`，字段为
  `inputTokens / outputTokens / totalTokens? / cacheReadTokens / cacheWriteTokens / reasoningTokens?`。
- 但**不要自己把 `assistant/message` 相加**：重试与替换（replacement）语义会让朴素求和重复计数。
  Harness 已有唯一正确的折叠实现——`@deepseek-ai/dsh-token-meter` 注册的 `tokenUsage` 投影：

  ```json
  "tokenUsage": {
    "ver": 2,
    "seq": 326,
    "val": {
      "totals": { "uncachedInputTokens": 43594, "outputTokens": 67742,
                  "cacheReadTokens": 1992832, "cacheWriteTokens": 0 },
      "last": { "turn": 1, "step": 40, "buckets": { ... } }
    }
  }
  ```

  持久化位置：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`。
- 聚合路径：

  | 场景 | 读法 |
  |---|---|
  | 冷会话（已持久化、不在内存） | `sessionProjectionCache.cachedSnapshot(header, ['tokenUsage'])`，同步零 I/O |
  | 活跃会话 | `sessionProjections.snapshot(liveSession, ['tokenUsage'])`，精确到当前 log 位置 |
  | 增量 | `sessionProjections.onChanged((session, key, value, seq) => ...)`，每个已提交事件给出绝对值 |
  | 兜底对账 | `sessionPersistence.open(id, 'read')` → `handle.read()` → `coldSnapshot()`，只在需要时用 |

- 实测成本：26 个会话 / 238 KB 投影缓存解析约 **1.54 ms**；作为对比，全量重扫
  27 个会话 / 33 MB 压缩日志 / 35,175 事件约 **477 ms**（线性增长）。所以重扫只适合对账，绝不进热路径。
- `tokenMeter.measure()` 是压缩压力用的启发式估算，**不是**计费用量，不要用它做统计。
- `sessionQuery.listEvents()` 只带元数据，没有 `usage` 负载，无法用于总量统计。

## 取舍

| 决策 | 理由 |
|---|---|
| 总量放在 Host 聚合 | Client 只拿到投影值无法跨实例求和；Host 值更新鲜，且余额本来就在 Host |
| 传输用 `webServer` 路由而非 Remote | 纯 JS 插件注册自定义 Remote 需要 typert 代码生成；路由足够、可 curl 自测 |
| 路由只允许回环 | 载荷含账户金额，声明式路由上没有通用准入层，默认拒绝非本机 |
| 不持久化聚合值 | `session_projcache` 已是权威的按会话缓存，重启后重算只要毫秒级，额外的持久化只会带来失效问题 |
| 跳过 `isSeeded` 会话 | 投影会折叠 fork 继承的前缀，直接相加会重复 |

## 未验证 / 开放问题

- Platform 的速率限制数值未公开，插件按保守策略（60 秒缓存 + 失败退避）设计。
- 超过 60 秒的余额新鲜度不做保证；需要精确值时点击刷新。
- 未实现 fork 继承前缀的精确扣减（当前直接跳过 fork 会话，代价是 fork 会话的自身新增用量不计入）。
