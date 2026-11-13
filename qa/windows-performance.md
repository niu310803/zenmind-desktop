# Windows / macOS 性能对照采集

## 首装加载诊断（默认开启）

这一组诊断写入 `logs/desktop/main.log`，正式安装包默认开启，不需要设置 `PERF` 或打开开发者工具。与下文可选的性能采集独立。

1. 在隔离的全新 Windows 运行环境安装并启动，记录 Desktop 版本、Windows 版本及故障发生的本地时间。不要清除现有用户数据来制造首装。
2. 出现“加载智能体失败”或“会话加载超过 15 秒”时，记录操作时间；恢复后再打开一次相同入口，记录恢复时间。
3. 从设置的“打开日志目录”或控制中心“打开日志位置”保存本次启动到恢复后的完整日志，包括轮转文件及 `agent-platform`、`identity-center` 服务日志。不要仅截取错误最后一行。
4. 在 macOS 做相同操作；慢/失败日志规则相同，正常快速加载不应持续产生新增日志。

定位顺序：

- `[platform-load]`：`operation` 区分服务可用性检查、`/api/agents` 和 `/api/chat`。每个操作有独立 `id`，超过 5 秒仅输出一次 `waiting`，最终输出 `succeeded/failed/cancelled`；失败即使不足 5 秒也记录。`uptimeMs` 可区分首启阶段；`stages` 为已完成阶段耗时，`stageElapsedMs` 为当前阶段耗时。这里的成功只代表宿主收到响应，不代表 WebClient 已渲染内容。
- `service-state` 慢或失败：查看 `serviceStatus` 和同期 `[bridge-pid]`。后者区分 PID 文件读取错误（例如 `EBUSY/EPERM/EACCES`）与进程身份探测结果（`unknown/mismatched`）、耗时及探测期间身份是否稳定。同类 PID 诊断最多每 30 秒一条，不记录路径、命令行或原始错误。
- `access-token` 慢或失败：结合 Identity Center 服务日志检查。凭据和原始错误消息不会写入新增诊断。
- `/api/agents` 或 `/api/chat` 停留在 `availability`：尚未完成服务检查及取凭据；停留在 `broker-response`：进入 Broker 连接/响应等待，结合 `connectionPhase/generation/reconnectCount`、`[agent-platform-realtime]` 与 Platform 服务日志判断。
- `[startup-checkpoint]`、`[program-data-cleanup]`：检查此前部署、验证、版本目录清理是否失败。仅有约十分钟后恢复的现象不能证明目录锁是原因，需要同一时间段的上述证据。

新增诊断不采集 token、Cookie、完整 URL、业务帧或聊天正文。需要测量主进程卡顿与资源占用时，再启用下面的可选性能采集。

## 开启与日志位置

打开「设置 → 关于」并连续点击「关于」五次，进入「调试 → 日志与链路」，开启「采集性能诊断」。完全退出 Desktop（包括托盘中的进程）并重新启动，确认日志目录的 `performance.jsonl` 写入了新的 `session-start`。

命令行采集可带 `PERF=1` 启动新进程，覆盖本次启动的关闭设置。已有单实例不会继承新环境变量。Windows PowerShell：

```powershell
$env:PERF = "1"
npm run dev
```

macOS Terminal：

```sh
PERF=1 npm run dev
```

安装版在同一终端直接启动实际可执行文件。Windows 使用 `& '实际安装路径\应用.exe'`；macOS 使用 `PERF=1 '/实际安装路径/应用.app/Contents/MacOS/实际可执行文件名'`，不要经 Finder 启动。

日志位于当前品牌数据根的 `logs/desktop/performance.jsonl`，与 `main.log` 同目录。采用 1 秒批量异步写入；单文件最多 10 MiB，保留一个 `.1` 轮转文件，待写队列最多 256 KiB，拥塞丢弃量写入 `dropped`。退出刷新为尽力而为，强制结束进程可能丢失最后一批。

关闭采集时关闭设置开关并重新启动。通过环境变量启动的实例，退出后在 Windows 执行 `Remove-Item Env:PERF`，macOS 若曾 export 则先执行 `unset PERF`。默认关闭运行期采集。每次启动仍会在日志目录更新一份有界的 `startup-timing.json`，记录阶段耗时和启动里程碑。各轮结束后分别保存此文件。

## Windows 基线与复测

用同一台机器分别运行优化前和候选安装包。低配机采用 4 核、8 GB、核显并开启 Defender 实时保护，记录磁盘类型。另用 16 GB、SSD 机器重复。每个场景跑五轮，保留单轮结果并比较中位数。记录 Desktop、Agent Platform、Agent WebClient 版本、Windows 版本、电源模式、显示缩放和本地时间。使用同一账号、模型、网络、对话数据和窗口尺寸，关闭 DevTools 与运行时观察器。首装和覆盖升级各轮从独立的 VM 快照或测试环境起步。

| 场景 | 操作与记录 |
| --- | --- |
| 首装 | 计时安装器启动至结束。启动 Desktop，记录窗口可见、主聊天文档加载，以及实际能输入聊天文本的时间。 |
| 覆盖升级 | 从同一旧版本升级。记录安装时间、首次启动各阶段耗时，核对原对话可打开。 |
| 冷启动 | 系统重启后首次打开已安装的 Desktop。记录窗口可见和实际能输入聊天文本的时间。 |
| 热启动 | 正常退出 Desktop 后重新启动，沿用同一系统会话。记录同样的时间。 |
| 流式对话 | 在相同模型和提示词下生成约 3000 字回答，流式输出时连续拖动窗口、滚动侧栏，记录起止时间与主进程 P99。 |
| 页面驻留 | 依次打开 6 个固定网站或网页应用，回到主聊天并静置 10 分钟。记录 guest 数、后台持续时间和工作集。 |
| 重启服务 | 在控制中心重启 Agent Platform，同时拖动窗口，记录重启窗口内的主进程最大事件循环延迟，确认原对话可再次加载。 |

同时保存 `startup-timing.json`、`performance.jsonl` 及存在的 `.1`、`main.log` 和安装器日志。窗口可见取 `milestones.main-window-visible`（毫秒，从进程启动计）。`renderer-first-contentful-paint` 与 `main-chat-document-loaded` 是主进程收到首次绘制及加载通知的时间，`rendererMilestones` 使用宿主 renderer 自己的时钟。实际可输入时间通过同一录屏或人工计时独立确认。启动阶段的 `eventLoopDelay` 从 Electron ready 开始采样，预启动读取注册表的同步 PowerShell 耗时单列为 `startup.sync-command`。其 `measuredSyncCommandCount` 只统计已埋点调用。需要检查是否存在其他同步调用时，用测试包的主进程跟踪记录定位。

低配机初始对照目标为热启动 2 秒内见窗口、8 秒内可输入，首装 40 秒内可输入。启动与服务重启时事件循环最大延迟分别对照 200 ms 和 100 ms，流式对话时对照 P99 50 ms。先记录实测基线，再核定目标。

## 固定复现流程

侧栏优化复测（Windows / macOS）：分别在展开侧栏、窄栏与置顶/项目列表中悬浮长标题，检查卡片内容、键盘焦点打开、Escape 关闭及拖动后的悬浮抑制；卡片打开期间更新标题/状态或语言应显示新值。切换 Chat 时未打开的卡片不应出现内容生成热点。保持导航顺序不变时，排序文件不应反复替换；实际拖拽、Alt + 方向键排序和置顶变更仍应保存，完整重启后顺序一致。模拟文件替换失败时原文件保持完整。

进程查询优化复测：重启开发进程后用原有两个 Chat 重复切换，比较 `main-chat-router-applied-accepted` 的耗时和 watchdog 回退数。首个冷身份查询允许异步等待；连续访问应复用近期成功观察。在 Windows 和 macOS 分别验证 Platform 停止、重启、新 Chat 与流式响应；停止后的请求不得复用失效身份。再次录制宿主 Performance 时，Frame Port 调用链中不应出现同步 `spawnSync`；身份相关的 live webview 读取仍保留。

1. 两平台使用相同 Desktop/WebClient/Platform 版本、账号和聊天数据，记录电源模式、屏幕缩放及是否打开 DevTools。性能测试期间保持窗口前台、DevTools 关闭。
2. 启动静置 30 秒；首次打开一个较长的历史 Chat，等待内容显示，再静置 10 秒。
3. 两个固定 Chat 往返切换 20 次，每次等内容显示；再快速连续切换 10 次，检查旧回调是否被拒绝。
4. 分别打开、隐藏、关闭 Copilot 和 WorkPanel，静置 60 秒。注意隐藏允许保留 guest，不等于关闭。
5. 收集 `performance.jsonl` 和存在的 `.1`，附上慢操作的本地时间、版本与复现步骤；另做一次关闭采集的对照，确认采集本身没有明显改变体验。

## 如何读数据

- `host-navigation-requested`：AppShell 的侧栏/历史等统一导航入口接受已有 Chat 的导航；并非物理鼠标按下时间。其 `switchId` 在路由精确匹配且 30 秒内被协调器消费时沿用。
- `main-chat-router-waiting-ready` → `chat-route-bridge-queued` → `main-chat-router-applied-accepted`：按 `switchId` 看 `elapsedMs` 差值。计时使用宿主的单调时钟；没有匹配入口的导航从协调器建立 transition 时开始。`hostMonoMs` 只可在同一个宿主 renderer 内相减。
- `main-chat-route-transition-replaced` 表示被替换，不能当作成功；`main-chat-router-applied-rejected` 表示确认未通过当前 revision/generation 校验，也不能当成功样本。
- `main-chat-router-timeout` / `main-chat-route-load-url-fallback`：确认是否触发整页重载。按 `instanceId + transitionId`、revision、documentGeneration 辅助关联；切换前后查看 guest ID 是否变化。
- `contents-observed/loading/dom-ready/loaded/destroyed`（实际 stage 均带 `contents-` 前缀）：所有 Electron WebContents 的生命周期，通过 `webContentsId` 关联资源快照中的 surface 和 PID。`contents-observed` 包含采集启动时已存在的实例，不代表一定刚创建。
- `resources`：每 5 秒采样，进程内存按 PID 去重；`deltaBytes` 只针对相同 PID + creationTime，首次为 null。关注 guest 数、孤立 guest 数以及关闭后连续多个采样的趋势。短暂未注册可形成孤立计数，不能凭单次采样判断泄漏。
- `resources.targets`：`backgroundDurationMs` 表示同一已登记 guest 在连续采样中处于非激活状态的时间，首次发现从 0 开始。对照 `surfaceRole`、`backgroundThrottling` 及 PID 工作集。共享同一 PID 的页面共用该进程的工作集。
- `service-resources`：Windows 每 30 秒异步读取 Identity Center、Agent Platform 和 Container Hub 的工作集，以已验证的服务 PID 查询。服务未运行、PID 变化或系统查询失败时记为空，WebClient 宿主已计入 Electron 进程。两个事件的采样时间不同，比较同一静置时段的样本。
- `host-responsiveness`：宿主长任务次数、总耗时、最大耗时和采样定时器延迟。`resources` 同时包含 main 事件循环最大值及 P99。最小化/后台节流也会增加定时器延迟，不能直接视为 CPU 阻塞。

`APPLIED` 明确是 `router-only`，**不代表历史数据加载完成或聊天内容上屏**。当前没有 WebClient 内部数据请求、React 提交、guest 长任务或 JS heap 埋点；这部分需在 WebClient 仓库补齐。生命周期加载事件同样不能代表聊天业务已就绪。

`resources.totalWorkingSetBytes` 是 Electron 进程工作集，包含主进程、renderer 和 GPU 等。`service-resources` 单独记录 Windows 受管服务进程，不含其子进程、独立 WebApp 进程或 Docker。Windows 另记可用的 Electron private bytes。跨平台比较相同操作后的增长趋势，判断是否泄漏需要观察多轮操作和回落情况。

性能通道仅允许主窗口顶层 frame 提交数值、布尔值及技术标识；不记录 URL、Chat ID、标题、正文或业务帧。此约束不改变既有普通诊断日志的策略。
