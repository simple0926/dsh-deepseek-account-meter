# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] - 2026-11-04

首个公开版本。

### Added

- Host 半边（`index.js`）：通过 `ctx.deepseekAccount` 读取账户余额，通过 `tokenUsage` 投影跨会话汇总
  token 用量，并用 `webServer` 暴露只接受回环地址的 `GET /dsh-deepseek-account-meter/summary` 路由。
- Client 半边（`client.js`）：在 `conversation.composer.dock` 注册一行余额 + 累计用量，8 秒轮询、
  切后台暂停、点击强制刷新、悬停查看分项明细。
- 失败语义：未登录显示「未登录」，读取失败显示「暂无数据」，余额失败永远不会被渲染成 `0`。
- 余额缓存：成功结果 60 秒，失败结果 15 秒后重试；`?refresh=1` 绕过缓存立即重读；
  账号登出 / 会话过期事件会立即清空缓存。
- 用量聚合：启动时用 `sessionProjectionCache` + live `sessionProjections.snapshot()` 对账一次，
  之后订阅 `sessionProjections.onChanged` 按绝对值增量替换，O(1) 更新且不重扫日志；
  fork 会话（`isSeeded`）跳过，避免重复计入继承前缀。
- 降级：缺少 `deepseekAccount` / `sessionPersistence` 等可选服务时仍返回 200，
  对应字段标记为不可用，并以退避重试代替永久失败。
- 主题与国际化：只使用 `--dsw-alias-*` 主题 token；中文 / 英文文案通过 Client locale 服务注册。
- 插件展示资源：`locale/{zh,en}.json` 标题与描述、原创 `icon.svg` 图标。
- 文档：中英双语 README、数据来源说明、GitHub 发布检查清单、Release 正文。

### Verified

- 路由行为：`GET`/`HEAD` 200、`POST` 405、未知路径 404、非回环地址 403、`?refresh=1` 绕过缓存。
- Client 注册：`conversation.composer.dock` 下 occupant `deepseek-account-meter`（order 2）为 active。
- Host 逻辑：8 项 stub 冒烟测试通过（happy path、绝对值增量替换、fork 排除、未登录、余额失败不为 0、
  回环 / 方法守卫、服务缺失降级、缓存与强制刷新）。
- 在 macOS 桌面版 DSH `0.2.1-rc.5` 上端到端可用，实测当日 29 个会话、1.55B tokens。

### Known limitations

- 仅在会话内渲染（composer dock 是 session 作用域）。
- 远程访问 / 非回环地址下不返回数据。
- 未提供跨实例合并与用量导出；如需这些能力请提 issue。
