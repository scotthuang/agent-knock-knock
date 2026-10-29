# 单命令发现与定向检查性能记录

日期：2026-10-29。基线为 `576f8c5` / core `0.16.6`；改动保留于
`perf/command-scoped-discovery` 工作区；本记录采集时尚未提交、推送、安装或发布。
以下数据与测试范围描述的是该开发验证时点，后续发布状态见 CHANGELOG 与对应 Release。

## 实测方法

修改前先执行 `npm run build`；最终验证使用 `npm run test:fast` 正式重建的 dist。
所有数据来自本机真实会话、全新 Node v24.19.0 进程，使用同一个 tclaude 可执行文件、
`~/.tclaude` 配置目录和 CLI 默认 Store。没有计入模型推理或 skill 阅读，也没有向会话发送任务。

通过 `NODE_OPTIONS=--require=<probe.cjs>` 预加载：hook
`ChildProcess.prototype.spawn` 以及同步 child_process 方法，记录启动次数、执行时间和退出状态。
子进程继承探针但不重复记录包装器内部调用，避免把 tclaude 内部执行二进制再计费。
表中的耗时是命令墙钟时间；不能用并发子进程累计时间替代它。基线每项一次，最终四个核心项目
各运行三次取中位数，Status 和显式 no-scan 为一次补测。测量命令均退出 0。

| 路径 | 修改前 | 修改后 | 子进程次数 |
| --- | ---: | ---: | ---: |
| `list` | 36.145 s | 2.560 s | 208 → 37 |
| `list --agent claude` | 25.951 s | 1.941 s | 100 → 19 |
| `list --agent codex` | 14.989 s | 1.214 s | 114 → 24 |
| `ClaudeNativeClient.inspect (one known identity, fresh peer verification)` | 2.457 s | 0.145 s | 5 → 2 |
| `status --conversation <same Claude native identity>` | 27.834 s | 3.478 s | 112 → 29 |
| `list --agent claude --no-approval-scan` | 15.326 s | 2.215 s | 56 → 19 |
| `list --agent codex --no-approval-scan` | 6.725 s | 1.202 s | 67 → 24 |

完整样本与分类计数见 [机器可读记录](command-discovery-performance.json)。
原始探针、测量驱动、逐次 JSON 输出、NDJSON 和验证日志位于
`/tmp/akk-command-perf-20261029/`；这些临时文件可能被系统清理。
核心复现方式：设置 `AKK_NATIVE_CLAUDE_BIN`、`CLAUDE_CONFIG_DIR`，重建后以同一探针执行
`node dist/src/cli.js list`、两个 `--agent` 变体及同一 `status --conversation`。
定向 inspect 驱动直接调用实际 `ClaudeNativeClient.inspect`，保留真实 socket peer 检查；
它的 100 ms 量级数据不等于整个 Status 工具的耗时。

## 地板与重复发现

- 最终 Claude List 三次 reader 调用分别为 1.548 / 1.514 / 1.620 秒，整个命令为
  1.980 / 1.841 / 1.941 秒，分别约为单次 reader 地板的 1.28 / 1.22 / 1.20 倍。
  整条命令已低于 3 秒，发现部分自然也低于该上限。
- 全量与 Claude List 的 tclaude 调用从 8 次变成 1 次。Codex List 从 1 次无关 Claude
  调用变成 0 次。定向 inspect 和完整 Claude Status 的 tclaude 调用都为 0。
- Codex 路径把 tmux 探测从 12 次降至 1 次、lsof 从 17 次降至 5 次、Herdr CLI 从
  48 次降至 3 次。剩余独立 routing-home 文件归属检查继续重新读取。
- Codex 发现仍需校验 Herdr socket、进程、pane 能力。将同一次发现的 33 个只读 IPC
  原样按顺序重放，耗时 3.398 秒；并发后的整个 Codex List 中位数 1.214 秒。
  这个串行观测地板尚未包含 ps/lsof/tmux/SQLite，已满足 1.5 倍约束。
- SQLite 的四次查询各有用途（快照完整性、schema、计数、分页），没有删掉验证来压数字；
  与终端和其他 native 发现并发。
- 显式详细 Claude List：`list --agent claude --approval-scan` 为 4.434 秒、69 次子进程，
  tclaude 仍仅一次。额外耗时属于明确要求的逐窗口详情检查。

## 行为变化和安全边界

单次 CLI execution 内的发现使用 AsyncLocalStorage 单飞和结果复用；新命令获得新缓存。
内部路由的输出捕获显式继承同一次执行的发现缓存，独立、并发或嵌套的新命令默认隔离。
失败 Promise 可重试。端点对象保留 Herdr WeakMap 私有证据，不能深拷贝后误丢 provenance。

默认 List 只发现会话、读取基础活动状态和提供可调用性。审批、Composer、原生 turn/items、
问题与进度详情由 Status、执行前置或显式扫描承担。`--no-approval-scan` 仍禁用扫描；
`--approval-scan` / MCP `noApprovalScan:false` 请求完整扫描。
新增 `detail_scan: deferred` / `send_preflight_required` 等说明，不伪造输入授权 token。
动作契约仍为 35、MCP List 投影仍为 v4；公开参数未增加，原字段未删除。
MCP 的私有动作解析对精确 terminal 执行详细 List，只检查该目标；其执行命令仍重新校验。
`--reconcile` 在启用 List 发现缓存标记之前执行，恢复流程不消费只读发现模式。

定向 Claude inspect 直接读取目标 registry，保留 UID、进程启动时间、registry、socket
所有权和 peer 身份验证。终端元数据也按 PID 新鲜读取；无 registry 或经验证的旧格式才保留
reader 兼容回退，非法记录、进程变化、parked/background 和配置目录冲突不能借回退放行。
发送意图持久化前后两次检查仍存在；缓存发现后目标变 busy 的测试要求零发送。
Store authority、消息代次、防重复投递、草稿/审批/问卷输入占用和回调路由均未放宽。

Herdr 的 working/idle 取自最后一份已校验 snapshot，只用于展示，不能证明输入可写。
`blocked` / `done` / 未知或 agent 不匹配不会伪装为审批通过或空闲。Claude `busy` 正确映射为 working。

## 验证与剩余限制

- `npm run test:fast`：3376 / 3376，fail 0。
- `npm run typecheck`、`npm run validate:architecture`、`npm run validate:refactor-evidence`：通过。
- `npm run skill:check`：由正式 build 执行，通过；`git diff --check`：通过。
- 新增/扩展用例覆盖：跨 runtime 单飞、跨命令隔离、失败重试、定向零枚举、PID 重用/文件权限/
  socket 拒绝、状态变忙后不得发送、端点私有证据保留、fresh resolve、无详情扫描的状态展示、
  明确完整扫描、精确目标隔离、reconcile 不继承发现标记和既有输入围栏。
- 初轮 fast 有 8 项失败：旧测试默认要求完整扫描，以及新夹具/描述摘要未同步。保留原安全
  断言，明确选择详细扫描、修正真实 catalog 夹具和 schema 文案摘要后全绿；没有删除围栏测试。
- 按 AGENTS.md 未运行 integration/full/release。此次没有进行真实业务 send/approve；现场验证
  使用只读 List、Status、目标 inspect 和 Herdr 只读探针。
- 完整 Status 仍约 3.48 秒：它还做终端状态和审批检查。没有声称整个工具已达到 100 ms。
- 无廉价状态来源的 tmux/未知 Herdr 状态仍显示 unknown，需要 Status；不会为了快猜 idle。
- 旧 registry 的兼容路径仍可能调用 reader。直接 native inspect 不能证明 interactive-kind 时
  保守拒绝；未通过删掉身份检查兼容未知 metadata。
- 多配置目录有有界并发，但本机真机只有一个配置目录，未宣称真实多目录场景已验收。

## 完整改动文件清单

- `config/production-module-ownership.json`
- `docs/command-discovery-performance.json`
- `docs/command-discovery-performance.md`
- `docs/list-output.md`
- `src/claude-agent-discovery-cache.ts`
- `src/claude-native-discovery.ts`
- `src/claude-terminal-agent-observation.ts`
- `src/claude-terminal-registry-observation.ts`
- `src/cli-core.ts`
- `src/cli-runtime-context.ts`
- `src/cli-usage.ts`
- `src/codex-native-cli-adapter.ts`
- `src/codex-native-public-projection.ts`
- `src/codex-store-adapter.ts`
- `src/conversation-list.ts`
- `src/conversation-routing-cli-adapter.ts`
- `src/conversation-usage-guidance.ts`
- `src/herdr-terminal-control-provider.ts`
- `src/semantic-tool-list-projection.ts`
- `src/semantic-tool-private-authority.ts`
- `src/semantic-tool-runtime.ts`
- `src/semantic-tool-schemas.ts`
- `src/terminal-control-provider.ts`
- `src/terminal-list-cli-adapter.ts`
- `src/terminal-list-facts.ts`
- `src/terminal-list-inventory.ts`
- `src/terminal-list-native-identity-recheck.ts`
- `src/terminal-process-source.ts`
- `src/terminal-runtime-cli-adapter.ts`
- `test/claude-native-client.test.ts`
- `test/claude-terminal-registry-observation.test.ts`
- `test/cli-runtime-context.test.ts`
- `test/codex-native-cli-adapter.test.ts`
- `test/codex-sticky-rollout-lifecycle-core.test.ts`
- `test/codex-store-process-probes.test.ts`
- `test/conversation-list.test.ts`
- `test/herdr-terminal-control-provider.test.ts`
- `test/list-discovery-isolation.test.ts`
- `test/model-control-cli-closed-loop.test.ts`
- `test/native-thread-lifecycle-cli-adapter.test.ts`
- `test/semantic-tool-catalog.test.ts`
- `test/semantic-tool-private-authority.test.ts`
- `test/terminal-control-provider.test.ts`
- `test/terminal-list-cli-adapter.test.ts`
- `test/terminal-list-inventory.test.ts`
- `test/terminal-process-source.test.ts`
- `test/terminal-runtime-cli-adapter.test.ts`
- `test/test-tiers.json`

## 发布复核补充（0.16.7）

默认摘要投影曾遗漏空线程分类所需的历史证据，会让同目录的空后台候选重新出现。
发行复核通过合成默认列表复现并补齐：只对同 Codex home/目录下有未命名 idle 候选的
多线程组读取现有精确快照，列表仅保留分类所需 ID/status，不输出任务正文。
未知或读取失败不会推断空历史，也不会隐藏候选；普通组保留摘要快速路径。
这类歧义组的快照读取可能涉及最新 turn 的 items，因此上文修复前测量不构成该分支的性能保证。
回归是隔离合成验证，本次未重新执行用户工作会话的派活或回调。
