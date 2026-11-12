# WebApp 独立 Platform 运行：方案

> 状态：一期代码已实施，已完成 macOS 开发态联调；Windows、打包 Mac 与原生 Linux 验收待完成。
> 核对日期：2026-11-11。基线：Desktop `5b4c4a302`、Agent Platform `ff6ad637`。
> 由 Desktop 与 Platform 两轮评估合并而来。第 1 节记录讨论中已经确定的结论，后续实施以本文为准。

## 1. 结论与范围

WebApp 分两种模式，长期并存：

- **Desktop 托管**（现有，`hosting` 缺省为 `desktop`）：保持不变。大多数只是网页的应用继续留在这里。
- **独立 Platform 运行**（新增，`hosting: "platform"`）：开发者在 Mac/Windows 上从 Desktop 启动；觉得好用的应用再部署到 Linux，由一个 Platform 容器独占承载。

唯一硬目标：**Desktop 上以独立 Platform 运行的应用，可以原样搬进 Linux 容器。**

由此确定：

1. 独立模式就是 Linux 容器的本地版：同一个 Platform 程序、同一套运行目录、同一份 `webapp.json`。Desktop 只负责建目录、解压、启动和打开页面。
2. 独立应用的前端、后端、智能体全部由 Platform 托管，Desktop 不托管它的前后端。
3. 实例保留 Agent。裁掉多应用托管、自动化、记忆整理、渠道和网关、知识库调度、邮箱、终端、lsp、语音。
4. 独立应用拿不到 Desktop 原生能力（剪贴板、对话框、通知、看板读取、Copilot 显隐、Chat 历史弹窗等），也不能使用主环境的智能体。给了就搬不走。
5. 不共享 Desktop 用户安装的全局技能；Platform 内置技能照常可用。

相对早期评估，以下内容不再需要：

- Desktop 把桥上的 agent、connector、mcp 等调用改发到实例；
- Copilot 面板和实时通道按应用连接实例；
- 智能体 key 前缀和归属记录；
- Platform 的 `webapp-install` 子命令和 agents/skills 同步步骤；
- 全局技能目录只读共享。

不在本方案内：Desktop 托管模式应用迁移或归一；独立应用的局域网访问、Tunnel 和发布。

## 2. 现状（已核对的代码事实）

**Platform**

- 已有 Linux Compose 多应用托管：`internal/webapp`、`internal/webappgateway`、`internal/webappbridge`、`internal/webapphost`，由 `--webapp-host=disabled|compose` 开启，仅限 Linux standalone。详见 Platform `docs/WebApp托管.md`。
- 现有目录：`webapps/<id>/app`（只读代码）、`webapps/<id>/{install,desired,policy}.json`、`webapp-data/<id>`、`.lock/webapps/instance.lock`。
- Node 固定为 `/opt/node/bin/node`，经 C supervisor + Landlock 运行，参数为 `--permission --no-addons --max-old-space-size=… --allow-fs-read=… --allow-fs-write=…`（`internal/webapphost/runner.go`）。非 Linux 的 runner 直接返回不支持。
- `internal/webapp/lock_windows.go` 目前返回 `webapp_host_platform_unsupported`。
- 运行目录全部从 `AP_RUNTIME_DIR` 派生，子目录名固定（`internal/config/config_defaults.go`）：`agents`、`skills-center`、`connectors-center`、`registries`、`chats`、`memory`、`pan`、`owner`、`root`、`ru-agents`、`webapp-data`、`.state` 等。可单独覆盖的只有 `AP_RUNTIME_REGISTRIES_DIR`、`AP_RUNTIME_CHATS_DIR`、`AP_RUNTIME_MEMORY_DIR`、`AP_RUNTIME_PAN_DIR`、`AP_RUNTIME_STATE_DIR`。
- 现有启动参数：`--config-dir`、`--port`、`--sso-id-token-file`、`--runtime-mode=standalone|desktop`、`--webapp-host`（`cmd/agent-platform/main.go`）。

**Desktop**

- 启动主 Platform 时注入 `--runtime-mode=desktop`（`src/main/modules/services/manager/lifecycle-command-policy.ts`）。
- WebApp 后端 launcher 在 `src/main/modules/webs/webapps/launchers.ts`；`electron-node` 用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 启动。
- Desktop 已把 Electron 自带的 Node 发布为普通 `node` 命令（`src/main/modules/services/manager/embedded-node-runtime.ts`）：
  - Mac：`bin/node` 是 sh 包装 `ELECTRON_RUN_AS_NODE=1 exec <Electron> "$@"`；
  - Windows：`bin/node.exe` 是 `native/node-launcher` 编译的启动器，只给子进程设 `ELECTRON_RUN_AS_NODE=1`，并放进关闭即结束的 Job Object。
- Electron 版本 42.11.4，自带 Node 24.19.0（实测）。
- 仓库中没有 Electron fuse 配置，RunAsNode 处于默认开启状态。

**两边后端环境变量命名不一致**

| 含义 | Desktop launcher | Platform runner |
| --- | --- | --- |
| 应用代码目录 | `WEBAPP_ROOT` | `WEBAPP_DIR` |
| 用户配置文件 | `WEBAPP_USER_CONFIG_PATH` | `WEBAPP_USER_CONFIG_FILE` |
| 仅一侧有 | `WEBAPP_STATE_DIR`、`WEBAPP_LOG_DIR`、`WEBAPP_MANIFEST_PATH` | `WEBAPP_KEY`、`NODE_ENV` |
| 两边相同 | `HOST`、`PORT`、`WEBAPP_ID`、`WEBAPP_DATA_DIR` | 同左 |

## 3. 目录结构

Desktop 为每个独立应用分配一个实例目录：

```text
<Desktop数据根>/data/webapp-platforms/<appId>/
├── runtime/          AP_RUNTIME_DIR，就是应用根；对应容器里的 /opt/runtime
├── config/           --config-dir，由 Platform 自己初始化，Desktop 不写
├── run/ready.json    Platform 启动后写回的端口和进程信息
└── logs/             Desktop 收集的 Platform 输出
```

`runtime/` 是扁平的，应用包解开就是一个 Platform 运行目录：

```text
runtime/
│  ── 应用包：ZIP 解出，升级时替换 ──
├── webapp.json
├── assets/
├── frontend/
├── backend/
├── agents/<agentKey>/          Platform 默认的 AgentsDir，直接读取
├── skills-center/<skillId>/    Platform 默认的 SkillsCenterDir，直接读取
├── connectors-center/<id>/     可选，第二期
│  ── 运行数据：Platform 和应用写入，升级时保留 ──
├── webapp-data/                应用后端业务数据（WEBAPP_DATA_DIR）
├── chats/  memory/  pan/  owner/  root/
├── registries/                 模型配置；Desktop 上可改指主环境（见第 5 节）
├── ru-agents/  ru-skills/  ru-connectors/   Platform 生成，可重建
├── .state/                     身份、连接器授权，以及 Platform 的托管记录
├── .staging/                   升级时暂存旧版本
└── .lock/
```

规则：

1. **包内与包外**：包内条目固定为上半部分这几项，其余都是运行数据。升级只替换包内条目；卸载时是否删除运行数据由用户明确选择。
2. **安装就是解压**：Desktop 解压到 `runtime/`，复用现有包校验和安装事务；容器里用 `COPY` 或解压到 `/opt/runtime`。Platform 启动时读根目录下的 `webapp.json` 校验，不提供安装子命令。
3. **升级逐项替换**：包内有多个顶层目录，无法一次换掉。先停实例，再逐项替换，旧条目暂存 `.staging/`，中断靠 journal 恢复；新版本健康后提交，失败回滚。Desktop 现有安装事务已有 journal，扩展即可。
4. **后端按项授权**：根目录下有 `.state/`（凭据）和 `chats/`，不能把根目录整体授权给应用后端。只授权读 `webapp.json`、`frontend/`、`backend/`，写 `webapp-data/` 和临时目录。Landlock 同样按项配置。
5. **包内目录只读**：单应用模式下 Platform 不提供智能体和技能的编辑，否则改动会在升级时被覆盖。
6. **单应用模式不创建被裁模块的目录**，如 `automations/`、`kbases/`。

## 4. webapp.json

新增两个字段：`hosting`（缺省 `desktop`，现有应用不受影响）和 `minPlatformVersion`。

```json
{
  "schemaVersion": 2,
  "id": "webapp-3f9a1c2b7d4e8f60",
  "key": "contract-review",
  "label": "合同审阅",
  "version": "1.0.0",
  "target": "any",
  "hosting": "platform",
  "minPlatformVersion": "0.6.0",
  "frontend": {
    "root": "frontend",
    "index": "index.html",
    "routeConfig": { "backendPrefixes": ["/api"] }
  },
  "backend": {
    "command": { "type": "node", "entry": "backend/server.mjs" },
    "health": { "type": "http", "path": "/api/health" }
  },
  "copilot": {
    "agentKey": "contract-reviewer",
    "references": [{ "type": "skill", "id": "clause-check" }]
  }
}
```

Desktop 读到不同 `hosting` 时的处理：

| | `desktop`（现有） | `platform`（独立） |
| --- | --- | --- |
| 装到哪里 | Desktop 的 WebApp 目录 | 解压到实例 `runtime/` 根目录 |
| 后端谁启动 | Desktop launcher | Platform |
| 页面地址 | Desktop gateway | Platform 应用端口，先换一次性票据再打开 |
| 页面 SDK | Desktop 桥，原生能力齐全 | Platform SDK，无 Desktop 原生能力 |
| 智能体 | 主 Platform | 包内 `agents/` |
| 局域网、Tunnel、发布 | 有 | 不提供 |

`hosting: "platform"` 的额外校验，写在共享的 `src/shared/webapp-manifest.ts`，重新生成 `contracts/webapp/`，Platform 同步同一份 schema 和 fixture：

- `copilot.agentKey` 必须是包内 `agents/` 下存在的智能体；`references` 的技能必须在包内 `skills-center/` 或 Platform 内置技能中；
- 不允许 `userConfig` 字段使用 `source: "desktop.agents"`；
- 不允许 `desktopBridge.kanbanRead`；
- 后端类型与 `target` 按第 5 节限制；
- 必须声明 `minPlatformVersion`。

顺带统一第 2 节表中的后端环境变量命名，避免应用换模式时要改代码。独立模式由 Platform 启动后端，以 Platform 的命名为准。

## 5. 后端类型

| 后端 | `backend.command` | `target` | Desktop 上运行时来源 | 容器里 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 纯前端 | 不写 `backend` | `any` | 不需要 | 不需要 | 第一期 |
| Node | `{"type":"node","entry":"backend/server.mjs"}` | `any` | Electron 自带 Node | 镜像内 Node 24 | 第一期 |
| 可执行程序 | `{"type":"executable","entry":"backend/bin/server"}` | 每平台一个包：`darwin-arm64`、`win32-x64`、`linux-x64` | 包内自带 | 包内自带 | 第二期 |
| Java / Python | `{"type":"runtime","runtime":"java","entry":"backend/app.jar"}` | `any` | 本机运行时 | 现有镜像没有 | 暂不支持，建议用 jlink / PyInstaller 打成可执行程序 |

- `node` 是新增类型名，含义为"Node 24，由宿主提供"。应用只声明需要 Node，用哪个 Node 由宿主决定：Desktop 给 Electron 的，容器给 `/opt/node` 的。`electron-node` 保留给 Desktop 托管模式。
- 可执行程序在 Mac/Windows 上没有 Node 权限模型可用，Desktop 上运行时没有隔离；Linux 上由 supervisor + Landlock 隔离。
- 模型配置：Desktop 上用 `AP_RUNTIME_REGISTRIES_DIR` 指向主环境的 `registries/`，沿用用户已配好的模型；前提是 Platform 保证单应用模式不写该目录。容器里挂载自己的 `registries/`。

## 6. 启动参数

```text
# 独立实例（Desktop 启动）
AP_RUNTIME_DIR=<实例>/runtime
AP_RUNTIME_REGISTRIES_DIR=<主运行根>/registries
agent-platform
  --runtime-mode=standalone
  --webapp-host=single                     新：单应用模式，保留 Agent，裁掉其他模块
  --config-dir=<实例>/config
  --listen=127.0.0.1:0                     新：随机端口
  --ready-file=<实例>/run/ready.json       新：写回实际端口
  --webapp-node=<Desktop数据根>/bin/node   新：Windows 为 node.exe
  --parent-pid=<Desktop 主进程 pid>        新：Desktop 崩溃时实例自行退出

# Linux 容器
AP_RUNTIME_DIR=/opt/runtime
agent-platform
  --runtime-mode=standalone
  --webapp-host=single
  --config-dir=/opt/configs
  --listen=0.0.0.0:8080
  （不传 --webapp-node 时默认 /opt/node/bin/node，经 supervisor + Landlock 运行）
```

`ready.json`：

```json
{
  "pid": 12345,
  "apiUrl": "http://127.0.0.1:53121",
  "appUrl": "http://127.0.0.1:53122",
  "platformVersion": "0.6.0"
}
```

- 应用页面沿用 Compose 模式"每应用一个独立 origin"，与 Platform API 端口分开，`ready.json` 同时报回两者。容器里两个端口都要暴露。
- `--webapp-host=single` 与 `compose` 不同，不限 Linux；`runtime/` 根下必须恰好是一个应用。
- `--runtime-mode` 在 Desktop 上用 `standalone` 还是 `desktop`，见第 11 节。

## 7. 使用 Electron 的 Node

启动参数只多一个 `--webapp-node=<Desktop数据根>/bin/node`。Desktop 已有的包装命令负责设置 `ELECTRON_RUN_AS_NODE=1`，Platform 当普通 Node 使用，不需要知道 Electron。

1. **版本**：Electron 42.11.4 自带 Node 24.19.0，与容器锁定的 Node 24 同一主版本。Platform 启动时探测 `--version`，主版本不符就拒绝。Desktop 升级 Electron 时必须守住这一条。
2. **隔离参数沿用 Linux 那一组**：在本机 Electron 42（macOS，未打包的开发版二进制）实测 `ELECTRON_RUN_AS_NODE=1 Electron --permission --no-addons --max-old-space-size=256 --allow-fs-read=<code> --allow-fs-read=<data> --allow-fs-write=<data>`：
   - 读代码目录：成功；写数据目录：成功；
   - 读未授权目录：`ERR_ACCESS_DENIED`；写代码目录：`ERR_ACCESS_DENIED`；
   - 启动子进程：`ERR_ACCESS_DENIED`；
   - 监听 `127.0.0.1` 随机端口：成功。

   Windows 和打包后的 Mac 应用尚未实测。
3. **少一层网络限制**：Linux 上 Landlock 限制 TCP 端口，Mac/Windows 没有。Desktop 上能连的外部端口，进容器可能被拦，反过来不会。应用要连的端口写进 manifest（对应 Platform 授权的 `ConnectPorts`），Desktop 上按同一份名单检查。
4. **不能用原生模块**：`--no-addons` 下 better-sqlite3 等无法使用，改用 Node 24 自带的 `node:sqlite`。Linux 打包工具已有纯 JS 约束，两边一致。
5. **进程回收**：Mac 包装用 `exec`，进程号不变，信号直达，按进程组回收；Windows 启动器加 Job Object，结束启动器即连带结束 Electron 子进程，按进程树回收。
6. **不要关闭 RunAsNode fuse**：以后做 Electron 安全加固时若关闭它，这条路就断了。

## 8. Desktop 实例生命周期

| 阶段 | 做法 |
| --- | --- |
| 安装 | 严格校验 manifest → 建实例目录 → 解压包内条目到 `runtime/` |
| 启动 | 按第 6 节参数启动 → 等 `ready.json` → 健康检查 |
| 打开 | 以 owner 身份向实例换一次性票据 → WebView 顶层 POST 到 `appUrl` → 进入应用 |
| 异常 | 有次数上限的自动重启；超过上限停在失败状态并展示日志 |
| 空闲回收 | 30 分钟内无请求且没有运行中任务、没有等待人工确认的任务才回收；关闭窗口不立即停止 |
| 退出 | Desktop 正常退出时停止全部实例；Desktop 崩溃由 `--parent-pid` 兜底 |
| 升级 | 按第 3 节规则 3 |
| 卸载 | 停止实例 → 删除实例目录；是否保留运行数据由用户明确选择 |

- 不提供"关闭独立环境、改用主 Platform"的开关，只提供停止和重启。
- 设置页标注"独立 Platform 运行"，不显示局域网和发布选项。
- 实例管理不放进现有服务管理器（它只管单例服务），新写模块。
- Mac 与 Windows 的进程启动、回收、路径分别显式处理。

## 9. 分工

**Platform**

1. 实现 `--webapp-host=single`：以 `AP_RUNTIME_DIR` 根目录为应用根，启动时读取并校验 `webapp.json`；包内目录只读；托管记录放 `.state/`；保留 Agent，不启动第 1 节列出的被裁模块。
2. Mac/Windows 上运行 Node 后端：使用 `--webapp-node`；无 supervisor 时直接启动 Node 并加隔离参数；Mac 按进程组、Windows 按进程树回收。
3. 后端按项授权（第 3 节规则 4），Linux 的 Landlock 同步调整。
4. 新增 `--listen`、`--ready-file`、`--parent-pid`。
5. 补 Windows 实例锁（`internal/webapp/lock_windows.go`）。
6. 单应用模式不写 `registries/`。
7. 启动时探测 Node 主版本。
8. 同步共享 schema 和 fixture，支持 `hosting`、`minPlatformVersion`、`node` 类型。

**Desktop**

1. `src/shared/webapp-manifest.ts` 增加 `hosting`、`minPlatformVersion`、`node` 类型和第 4 节的校验，重新生成 contracts。
2. 新增实例管理模块，覆盖第 8 节全部阶段。
3. 安装事务支持解压到实例 `runtime/` 根目录并逐项替换包内条目。
4. 打开流程：换票据并在 WebView 中打开 `appUrl`。
5. 设置页展示独立运行状态，隐藏局域网和发布。
6. 统一后端环境变量命名（与 Platform 协商）。
7. 更新 `docs/本地网站应用.md`，增加这一形态；按 `qa/manual-regression.md` 补充回归项。

## 10. 部署到 Linux 容器

- 镜像只带 Platform（含 Node 24、supervisor）；应用放在挂载到 `/opt/runtime` 的卷里，可以是整个实例 `runtime/`，也可以只是解压后的应用包。
- 启动参数见第 6 节。
- 部署前检查：
  - `minPlatformVersion` 不高于镜像中的 Platform 版本；
  - 智能体引用的模型 key 在容器的 `registries/` 中存在；
  - 后端类型为 `node`，或 `target` 为 `linux-x64` 的可执行程序；
  - 应用要连接的端口都在 manifest 名单内。

## 11. 待定问题

1. **开发态**：第一期每次改代码都要重新打 ZIP 安装。第二期是否支持直接挂载源码目录（跳过完整性校验）？
2. **模型配置**：借用主环境 `registries/`（建议，用户无需重配），还是实例自己配置？
3. **实例在 Desktop 上的鉴权**：沿用主 Platform 的 desktop 模式验签，还是与容器一致使用 standalone + owner？不影响应用代码，由 Platform 决定。

## 12. 验收

- Mac 与 Windows 分别验证：安装、启动、`ready.json`、打开页面、智能体对话、空闲回收、Desktop 崩溃后实例退出、升级成功与回滚、卸载保留或删除数据。
- Windows 和打包后的 Mac 应用上，实测第 7 节的 Node 隔离参数。
- 同一个应用包在 Linux 容器中按第 10 节跑通。
- `hosting: "platform"` 的合法与非法 manifest fixture 在 Desktop 和 Platform 两侧都通过。

## 13. 一期实施记录（2026-11-11）

- Desktop 已接入共享 Manifest/fixture、独立实例进程管理、按项升级与 journal 回滚、owner 顶层 POST、专用无 preload 的 WebView、配置 API、关闭保留实例、空闲门禁、卸载数据选择及设置入口；现有托管模式保持。同步设计文档与自动/手工回归。
- Platform 一期在独立 chat 实施；精确对接与测试说明见 `agent-platform/docs/WebApp独立实例.md`。已提供 single 装配、Node 24、权限、ready/parent-pid、owner、状态接口、Windows 锁及模块裁剪。
- 模型配置选用主 registries 只读共享；实例采用 standalone + 每次启动轮换的本地 owner，凭证只由 Main 读取，不注入应用。
- Desktop 的 macOS 开发态真实 Electron 联调验证：Node 24.19.0、独立 origin、顶层 POST 会话、HttpOnly Cookie、两类 WebView 不带 Desktop preload、敏感目录读取/代码写入/子进程被拒绝，以及完整后代回收。Chromium 对 browser-initiated POST 的 Origin 覆写由精确 guest 的一次性请求钩子处理。
- Platform 自身已验证包内 Agent/Skill 的 mock 模型 SDK 对话、父进程退出、Platform 强杀后的回收重启和共享 registries 不变；三平台 Go 构建及相关模块回归通过。

尚未完成的验收与协议项：

- Windows 实机、打包 macOS，以及原生 Linux amd64 的新版 Landlock/容器生命周期验收。Docker Desktop amd64 仿真返回 Landlock ENOSYS，按策略拒绝运行，不视为原生 Linux 通过。
- 方案中的 Manifest 网络端口名单尚无共享字段。当前 Linux 沿用 owner policy 的 connectPorts，Mac/Windows 不能限制 TCP；需要后续统一该字段，不能声称由同一 Manifest 自动授权。这是对第 7、10 节的明确阶段性差异。
- 当前 Platform 版本仍为 0.5.46，未因实现 single 自动升版；本文示例的 minPlatformVersion 0.6.0 在当前版本应被拒绝。实际包应声明其真实最低版本，或等待配套发布升版。
- 持续 WebSocket 的 Desktop 空闲门禁保守保留到 guest 销毁，避免活跃连接被回收。owner 状态或业务请求未空闲时不停止。
