# WebApp Copilot 自动注入应用 MCP：评估与完整方案

> 状态：方案，未实施。
> 核对日期：2026-11-09。基线：Desktop `37bc365a3`、Agent Platform `99737926`、Agent WebClient `d8d131eb`。
> 替代先前“运行时 MCP Binding（不透明 bindingId + mcpBindings 字段）”草案。按用户要求收敛为“一个 WebApp 一个 MCP、打开 Copilot 自动注入、全部内存态”。

## 1. 目标与结论

目标：Desktop 打开 WebApp 后，该应用的 Copilot 在每次发送消息时，自动让本次 Run 获得这个 WebApp 后台提供的 MCP 工具。同一个 Agent 在 WebApp A 的 Copilot 中拿到 A 的工具，在 B 中拿到 B 的工具；不修改 `agent.yml`、不重建 Agent、不写任何文件。

结论：可行，而且可以复用三条现有机制，不需要新增 Binding 概念：

1. **身份**：直接用 WebApp 身份派生的确定性键（`webapp-<hash>`）作为 MCP server 键。一个应用只有一个 MCP，不需要 bindingId 和映射表。
2. **请求通道**：复用 Copilot 现有的“宿主固定引用”链路（Desktop 把 skill 引用作为不可移除标签交给 WebClient，WebClient 随每条消息放入 query `references`），增加一种 `{type:"mcp"}` 引用。
3. **执行**：复用 Platform 现有的 MCP 连接、tools/list 同步、实例工具命名（`mcp_<hash>_<name>`）、Session 冻结工具集和 ToolRouter 路由，只增加“运行时 server 表”这一种来源。

注入全程在进程内存中完成：Platform 内存保存注册表和工具定义，Run 的 `QuerySession` 冻结本次工具集；Desktop 内存记录注册状态。唯一落盘的是 Manifest 的静态声明和聊天记录里的引用痕迹，详见第 9 节。

改动规模中小，三个仓库需同批发布。Platform 约 7 处：Registry、ToolSync 命名、注册接口、引用归一化、interaction 校验、Session 合并、Router 校验。Desktop 约 7 处：Manifest、条目投影、注册模块、运行状态回调、IPC、前台 Dock、后台 assistant.chat。WebClient 3 处。除注册接口和注册模块外，其余都是在已有机制上加分支。

### 1.1 对原草案的取舍

| 原草案 | 本方案 | 理由 |
| --- | --- | --- |
| Desktop 注册后返回不透明 `bindingId` | Desktop 自行计算确定性键 `webapp-<sha256(webappId) 前 24 hex>` | 一个应用一个 MCP，键天然唯一；Platform 不需要发号和映射 |
| 请求新增 `mcpBindings` 字段 | 复用 query `references`，新增 `type:"mcp"` | 宿主固定引用链路已存在，WebClient/Platform 本来就要同批发布 |
| 每个 Run 单独“取得使用资格” | 引用随每条消息发送，Run 创建时冻结进 `QuerySession` | 现有 `ToolSetFrozen` 与 `AllowsTool` 已经按 Run 生效 |
| 防止“切到 B 后 A 的旧 Run 操作 B” | 自然满足 | `webapp-A` 的键永远不会指向 B |
| Binding 撤销后旧 Run 调用失败 | 注销即从 Registry 移除，调用返回现有 MCP 错误 | 不需要额外撤销状态机 |
| 凭据引用、逐 Binding 工具白名单、工具快照 | 首版不做 | 本机 loopback、安装即信任，暂无需求 |
| Platform 不理解应用身份 | 保持：Platform 只看到不透明键和 URL | 边界与 Platform `docs/连接器执行协议.md` 一致 |
| Desktop 不转发 MCP 调用 | 保持：Platform 直连 WebApp gateway | 少一跳，Desktop 只管生命周期 |

被否决的更简做法：请求直接携带 MCP URL，由 Platform 现场连接。query 接口不只 Desktop 使用，这会让任意 query 调用方指挥 Platform 连接任意地址。注册这一步必须保留，用来保证“谁能挂 MCP”只由持有宿主 token 的 Desktop 决定。

## 2. 首版范围与取舍

| 决策项 | 首版决定 | 原因 |
| --- | --- | --- |
| 每个应用的 MCP 数量 | 恰好 0 或 1 个 | 用户约束；Manifest 用对象而不是数组 |
| 传输 | 仅 streamable-http，经 WebApp loopback gateway | gateway 已统一代理后端；Platform 已支持该传输 |
| MCP 鉴权 | 不做 | gateway 仅监听 `127.0.0.1`，页面访问后端本来也不带 token |
| 注入入口 | 前台 Copilot Dock 与后台 `assistant.chat`（WebApp 调用） | 与现有 skill 引用“前后台共用一条链路”保持一致 |
| 生效范围 | 仅携带引用的根 Run | 子任务、side lane、TEAM 成员首版不继承 |
| 是否跨消息继承 | 不继承；每条消息必须由当前宿主重新带上 | 避免重开旧聊天自动挂上已关闭的应用 |
| 未就绪时 | Platform 拒绝 query，返回 `mcp_binding_unavailable` | 不允许空工具集启动却显示“已注入” |
| 工具展示模式 | 直接工具与 `mcp_search`/`mcp_call` 两种都支持 | 共用同一份运行时挂载，只是呈现方式不同 |
| 持久化 | 全部内存；Platform 重启后由 Desktop 重新注册 | 用户要求“虚拟注入” |

首版不做：

- WebApp 多 MCP、stdio MCP、远端或 LAN 地址的 MCP。
- Platform 托管的 Linux Compose 应用注入（包格式可表达，不代表云端已交付）。
- 发布页、Tunnel 访客、独立窗口以外的远端页面使用该 MCP。
- 用户在 Copilot 中手动移除或添加 MCP 标签。
- Desktop 侧对 MCP 调用的转发、审计或改写。

## 3. 总体流程

```text
WebApp 启动成功（后端健康）
  └─ Desktop Main：PUT /api/mcp/runtime-servers {key, name, url}
       └─ Platform：放入内存运行时表 → 连接 → tools/list → 生成 mcp_<hash>_<tool>
用户打开该应用的 Copilot
  ├─ Desktop Renderer：WebClient URL 追加 reference={type:"mcp",id:key,name}
  └─ Desktop Main：幂等 ensure（覆盖 Platform 重启后丢失注册的情况）
用户发送消息
  └─ WebClient：query.references = [skill..., {type:"mcp",id:key}]
       └─ Platform Session 构建：
            校验 key 已注册且 ready（否则拒绝 query）
            → 合并进 ToolNames / MCPServerKeys / RuntimeMCPServerKeys
            → ToolSetFrozen 冻结 → 发送给模型
模型调用 mcp_<hash>_update_shape
  └─ ToolRouter：AllowsTool → 本 Run 持有该运行时键 → tools/call 到 WebApp gateway
WebApp 停止 / 重启 / 卸载
  └─ Desktop Main：DELETE → Platform 移除 server 与工具；旧 Run 后续调用失败
```

## 4. 契约

### 4.1 Manifest：`mcp`

```json
{
  "backend": { "...": "..." },
  "frontend": { "routeConfig": { "backendPrefixes": ["/api"] } },
  "mcp": { "path": "/api/mcp" }
}
```

规则（在 `src/shared/webapp-manifest.ts` 的 schema 与 `superRefine` 中实现）：

- 顶层可选字段 `mcp`，`z.strictObject({ path })`。放在顶层而不是 `copilot` 下：它描述应用提供的能力；未声明固定 `copilot`、而使用 `userConfig.agentKey` 的应用也应当能注入。
- `path`：以 `/` 开头，最长 128 字符，不含 `..`、查询串、片段、反斜杠和控制字符。
- 必须声明 `backend`，且 `path` 必须命中某个 `backendPrefixes`（与 gateway `shouldProxyRequest` 相同的判断：等于前缀或以 `前缀/` 开头）。
- 不得落在 Desktop 保留前缀内。
- 只允许 streamable-http，不暴露传输选项。

修改后运行 `npm run webapp-contract:generate`，重新生成 `contracts/webapp/webapp.schema.json` 和 validator，并同步更新 `contracts/webapp/README.md`。

### 4.2 绑定键

```text
key = "webapp-" + sha256(utf8(webappId)).hex.slice(0, 24)
```

- WebApp 身份保留原始大小写、文字和空格，而 Platform MCP 键会被 `normalizeKey` 转成小写。直接用 `webapp:<id>` 会让 `Foo` 和 `foo` 冲突，也会把空格和非 ASCII 字符带进工具名。所以由 Desktop 做哈希，得到纯 ASCII 小写键。
- 键只由 Desktop Main 计算，Renderer 和 WebClient 只做透传，页面不能指定。
- Platform 把它当作不透明字符串，校验 `^[a-z0-9][a-z0-9._-]{0,63}$`。Platform 内部 server key 为 `runtime:<key>`，以区别于 Agent 版本化挂载键。
- 工具名沿用 `agentToolName(serverKey, wireName)`，即 `mcp_<16 hex>_<name>`。键不变则工具名不变，同一个应用的多个 Run 之间工具定义保持稳定，对提示词缓存友好。

### 4.3 Platform 注册接口（新增）

```text
PUT /api/mcp/runtime-servers
Authorization: Bearer <Desktop 宿主 token：scope=app 且带 deviceId>
{ "key": "webapp-3f9a…", "name": "画布", "url": "http://127.0.0.1:39127/api/mcp" }

200 → { "key": "webapp-3f9a…", "status": "ready", "toolCount": 3 }

DELETE /api/mcp/runtime-servers?key=webapp-3f9a…
200 → { "removed": true }   // 不存在也返回 200，保证幂等
```

- 鉴权复用 `connectorAuthoritySubject`（`internal/server/handler_connector_execution.go:17`：要求 `scope=app` 和 `deviceId`），并把该路径加入 `internal/server/server_auth.go:49` 的 `forceAuth` 列表。
- `url`：必须是 `http:`，主机只能是 `127.0.0.1`，不能带用户信息，长度不超过 512。不接受 `localhost`，避免 Windows 上解析成 `::1` 后与 gateway 的 `127.0.0.1` 监听不一致。
- `name`：用于 `mcp_search` 结果和诊断，不超过 64 字符。
- PUT 是同步的：写入运行时表，执行一次有界的（10 秒）initialize 和 tools/list 后才返回。失败时删除该条并返回错误，不留下“pending 但不可用”的条目。
- 同一个 key、同一个 url 且已 ready 时直接返回，不重连。url 变化（应用重启换了端口）则替换并重新同步。
- 上限 64 条，超出返回 `mcp_runtime_capacity`。
- 错误体与连接器执行接口一致，放在 `data.errorCode`，这样 Desktop 现有的 `webapp-platform-client.request()` 可以直接解析。

### 4.4 Copilot 引用

```json
{ "type": "mcp", "id": "webapp-3f9a…", "name": "画布" }
```

- Desktop → WebClient：和 skill 一样走 URL 参数 `reference=<JSON>`（`AgentWebclientCopilotDock.tsx:42`）。
- WebClient → Platform：放进 query `references`，每条消息都带。
- 每个请求最多 1 条 `mcp` 引用。
- 只有 query（聊天发送）接受 `mcp` 引用。steer、automation、`/api/execute`、管理工具的 `LocatorReferences` 一律拒绝。

### 4.5 错误码

| 错误码 | 位置 | 含义 |
| --- | --- | --- |
| `mcp_runtime_invalid` | 注册接口 400 | key、url 或 name 不合法 |
| `mcp_runtime_unreachable` | 注册接口 502 | 连接、initialize 或 tools/list 失败 |
| `mcp_runtime_capacity` | 注册接口 409 | 超过 64 条 |
| `mcp_binding_unavailable` | query 准入 409 | 引用的 key 未注册或未 ready，Run 不启动 |
| `mcp_binding_not_mounted` | 工具调用 | 运行时工具被未持有该 key 的 Run 调用（防御性检查） |
| 现有 `tool_not_registered` / `mcp_server_unavailable` | 工具调用 | 应用停止后旧 Run 的调用 |

## 5. Desktop 改动

### 5.1 Manifest 与条目投影

- `src/shared/webapp-manifest.ts`：按 4.1 增加 `mcp`，重新生成契约。
- `src/shared/contracts/webs.ts:46`：`copilotReferences` 的类型扩展为 `{type:"skill";id:string} | {type:"mcp";id:string;name:string}`。
- `src/main/modules/webs/webapps/store.ts:366`：生成条目时，如果 `manifest.mcp` 存在，就在 `copilotReferences` 末尾追加 mcp 引用（key 按 4.2 计算，name 取应用 label）。无论是固定 `copilot` 还是 `userConfig.agentKey` 分支都要追加，所以需要把这段投影改写成“先求 skill 引用，再拼接 mcp 引用”。

### 5.2 注册模块（新增）

新文件 `src/main/modules/desktop-actions/webapp-copilot-mcp.ts`，与 `webapp-platform-client.ts` 放在一起，复用其 `platform()` 和 `request()`：

```ts
register(webappId)    // runtime 为 running 且声明了 mcp → PUT
unregister(webappId)  // DELETE；失败只记日志
ensure(webappId)      // 与 register 相同；同一 webappId 的并发调用合并为一个 in-flight Promise
reregisterAll()       // 对所有 running 且声明了 mcp 的应用调用 register
```

- url = `runtime.webUrl`（`gateway.ts:695` 生成 `http://127.0.0.1:<port>/`）加上 `manifest.mcp.path`。
- 注册状态（key → url）只放在模块内存的 Map 里，不写设置、不写 journal。
- 失败只记录日志并清除内存状态，不弹窗。用户能看到的失败出现在发送消息时，由 Platform 返回 `mcp_binding_unavailable`。

触发点：

| 事件 | 动作 | 挂点 |
| --- | --- | --- |
| WebApp 启动成功（health 通过） | `register` | `WebappRuntime` 新增最小的运行状态回调端口（类似 `setPublicationChangeListener`，`runtime.ts:65`），在组合根 `src/main/app/assembly/assistant.ts:110` 附近接线。不复用 `DesktopWebappChangedReason`，它是手机端公共事件契约 |
| WebApp 停止、重启、卸载、`stopAll` | `unregister` | 同一回调端口的 stopped 分支 |
| 打开该应用的 Copilot | `ensure` | 新增 IPC `webapps.ensureCopilotMcp(webappId)`（preload、`desktop-api` 契约、`ipc-registration-contracts.ts`）。Renderer 在 Copilot Dock 对 webapp 条目可见时调用 |
| agent-platform 启动或重启成功 | `reregisterAll` | 当前 services facade 没有现成的状态变化事件。实施时在 Desktop 自己的 agent-platform 启动成功路径上新增一个最小回调，只选一个挂点 |
| WebApp 后台 `assistant.chat` 启动 Run 前 | `ensure` | `action-dispatch.ts:102-142` |

webs 模块不能直接 import desktop-actions，跨模块依赖通过组合根注入的端口完成，以通过 `architecture:check`。

### 5.3 前台 Copilot

- `src/renderer/app-shell/AppShell.tsx:1273`：`resolvedCopilotReferences` 原样取 `activeWebEntry.copilotReferences`，其中已包含 mcp 引用，不需要改逻辑。只需在 Dock 打开时调用 `ensureCopilotMcp`。
- `src/renderer/copilot/sidebar-copilot/AgentWebclientCopilotDock.tsx:42-51`：`appendReferences` 和 `buildAgentWebclientCopilotPath` 的参数类型放宽为联合类型，序列化方式不变。
- 网站（website）条目从来不带 mcp 引用。

### 5.4 后台 Copilot（WebApp 发起的 `assistant.chat`）

`src/main/modules/desktop-actions/action-dispatch.ts:102-142`：

- 目前 `references` 只来自 `item.copilot.references`，`skillIds` 会整体替换它。改为：先确定 skill 部分（固定引用或 `skillIds` 子集），再在末尾追加 mcp 引用。追加不受 `skillIds` 影响，也不受是否声明了 `copilot` 影响。
- 启动 Run 前调用一次 `ensure`。

### 5.5 Desktop 不做的事

- 不向 Platform 写任何配置文件，不修改服务的 `.env`，符合 AGENTS.md 中内置服务边界的约定。
- 不代理、不检查 MCP 调用。
- 不在 UI 上额外增加“已注入”状态面板；WebClient 输入框里的锁定标签就是用户能看到的状态。

## 6. WebClient 改动

- `src/features/composer/components/HostRequiredSkillsContext.tsx`：解析 `reference` 时，除 skill 外也接受 `type:"mcp"`。id 用 4.2 的正则校验，最多 1 条。建议把 `HostRequiredSkills` 扩展为 `{ agentKey, skills, mcp? }`，不另开一个 Context。`CopilotShell.tsx:273` 的读取入口保持不变。
- `src/features/composer/components/ComposerArea.tsx:296-313`、`:844`：把 mcp 渲染成不可移除的锁定标签（显示 `name`），并加入 `sendReferences`。与 forced skill 一样，只在 `agentKey` 与宿主一致时生效。
- `src/features/timeline/lib/queryResend.ts` 的 `referencesForNewChat`，以及失败重发、编辑重发：从历史快照中**去掉** `type:"mcp"`，由当前宿主上下文重新附加。时间线渲染遇到 mcp 引用时显示名称或隐藏，不报错。

## 7. Platform 改动

### 7.1 Registry 运行时表

`internal/mcp/registry.go`：

- 在 `Registry` 上新增 `runtime map[string]ServerDefinition`，与磁盘加载的 `servers` 分开保存。
- 现有的 `Reload()`（`registry.go:55`）整体替换 `r.servers`。为避免连接器变化时把运行时条目冲掉，`Server()`、`snapshot()` 改为读取两张表的并集。
- 新增 `SetRuntimeServer(def)` / `RemoveRuntimeServer(key)`，修改后 `version++`。
- 运行时 `ServerDefinition`：`Key="runtime:<key>"`，`Name=name`，`Transport=TransportStreamableHTTP`（`types.go:55`），`BaseURL`/`EndpointPath` 由 url 拆出，新增标记字段 `Runtime bool`，不设 `AgentKey`，不设凭据相关字段，也没有 `StateRoot`。
- 接入 ToolRouter 实际使用的那一套 Registry/ToolSync 实例（Agent 作用域实例，见 `agent_registry.go:18`）。实施时在组装处确认是哪一个。

### 7.2 ToolSync 命名

`internal/mcp/tool_sync.go:442`：现在只有 `server.AgentKey != ""` 时才生成实例工具名 `mcp_<hash>_<name>` 并写入 `mcpToolName`；其他情况直接使用远端原名，可能与内置工具重名。改为 `server.AgentKey != "" || server.Runtime` 时都走实例命名，并补充 `Meta["runtimeServer"]=true`。`agentKey` 只在 Agent 挂载时写入。

### 7.3 注册接口

新增 `internal/server/handler_mcp_runtime.go`，按 4.3 实现，在 `server_routes.go` 中注册路由。PUT 流程：

```text
校验 → SetRuntimeServer → ToolSync.ReconcileRegistry()
     → RefreshServersWithResult(ctx(10s), ["runtime:<key>"])
     → status != ready 时 RemoveRuntimeServer 并返回 mcp_runtime_unreachable
```

DELETE 流程：`RemoveRuntimeServer` → `ReconcileRegistry()`。工具快照会立即失效（`tool_sync.go:170` 的语义）。

### 7.4 query 引用解析与准入

- `internal/contracts/queryinput/references.go:57`：`NormalizeResourceReferences` 增加 `case "mcp"`，要求 id 非空并去重。不要加入 `LocatorReferences`。
- `internal/interaction/config.go:140`：`ValidateReference` 目前把未知类型归入 `default` 分支，按 `Attachment.LocalFiles` 开关放行或拒绝（调用点 `internal/runtime/query/query_interaction.go:27`）。需要增加 `case "mcp"`。mcp 是宿主注入的能力，不是用户附件，因此不受 Agent `interactionConfig.attachment` 各开关约束；否则关闭了本地文件附件的 Copilot Agent 会以 `interaction_disabled` 拒绝请求。
- steer（`internal/contracts/steer.go:44`）、automation、`/api/execute` 的 DTO 遇到 `mcp` 引用一律拒绝。工具集在 Run 创建时已冻结，Run 中途不能追加。
- 准入：Session 构建时用 `queryinput.ResourceIDs(req.References, "mcp")` 取出 key。不存在或 ToolSync 状态不是 ready 时返回 `mcp_binding_unavailable`，Run 不启动。这个错误要映射到 query 的错误响应，具体位置实施时确认。

### 7.5 Session 合并

`internal/runtime/session/session_builder.go:180` 附近：

```go
runtimeKeys := runtimeMCPServerKeys(req.References)          // "runtime:<key>"，已在 7.4 校验
configuredToolNames, mcpServerKeys := SessionMCPTools(
    EffectiveAgentTools(agentDef), agentDef, runtimeKeys, s.deps.Config.MCP.ToolMode,
    func() []string {
        return McpToolNamesForServers(s.deps.Tools, append(agentDef.ConnectorMCPServers, runtimeKeys...))
    })
```

- `SessionMCPTools`（`:593`）当前只在 `agentDef.ConnectorMCPServers` 非空时提供 `mcp_search`/`mcp_call`，并返回服务键。改为在“固定挂载或运行时挂载任一非空”时提供，返回值包含两者。
- 运行时工具名在 `BuildSessionToolNames`、`RuntimeModeToolNames`、规划模式排除等过滤**之前**并入，让它们和普通工具一样经过权限与阶段过滤。
- `QuerySession` 新增 `RuntimeMCPServerKeys []string`，两种模式都赋值，供 7.6 校验使用。现有 `MCPServerKeys` 只在 tool mode 下使用，语义不变。
- `options.SubTaskID != ""`、side lane、TEAM 成员 Run 不并入运行时键（首版边界）。
- LLM 层不用改：`llm_engine.go:103` 从 `session.ToolNames` 和全局定义求交集，`ToolSetFrozen` 时冻结实际下发的定义。应用如果在 Run 进行中被停止，后续阶段的定义集会自然缩小。

### 7.6 ToolRouter 校验

`internal/tools/tool_router.go:396` 的 `callMCPTool` 在现有 `agentKey` 检查之后追加：

```go
if AnyBoolNode(def.Meta["runtimeServer"]) &&
    (execCtx == nil || !slices.Contains(execCtx.Session.RuntimeMCPServerKeys, serverKey)) {
    return nil, &mcpCallError{"mcp_binding_not_mounted", "runtime MCP is not mounted by this Run"}
}
```

直接工具调用已经先经过 `AllowsTool`（`tool_router.go:244`），`mcp_call` 已经先经过 `MCPServerKeys` 范围检查（`tool_mcp_gateway.go:74`）。这里是第三道独立防线，保证两个 Run 即使使用同一个 Agent 也不会共享对方注入的 MCP。

### 7.7 不继承

- `internal/runtime/session/chat_skills.go` 的 `inheritChatSkills` 会从聊天历史继承 skill。**mcp 不得照搬**，只认当前请求的引用。
- 聊天记录（`internal/chat/query_line.go:74`）照常记录 `references`，只作为历史痕迹，不参与后续 Run 的装配。

## 8. 生命周期与状态

| 场景 | 结果 |
| --- | --- |
| 应用已运行，打开 Copilot 后发送 | 启动时已注册，ensure 立即返回，Run 获得工具 |
| 应用刚启动就立刻发送，注册尚未完成 | query 返回 `mcp_binding_unavailable`；用户重发即可（窗口通常在 1 秒内） |
| 切换到另一个应用的 Copilot | 后续消息带新应用的 key；进行中的旧 Run 保留旧 key，只能调用旧应用 |
| 应用停止或卸载 | DELETE；旧 Run 的后续调用失败，新消息被拒绝 |
| 应用重启（端口变化） | 先 DELETE 再 PUT，key 不变；间隙内的调用失败，之后旧 Run 的调用会落到新实例（视为同一应用，可接受） |
| Platform 重启 | 内存注册全部丢失；Desktop 通过 `reregisterAll` 和下次打开 Copilot 时的 ensure 恢复 |
| Desktop 重启 | 应用随 Desktop 重新启动并重新注册。如果 Platform 没有跟着重启，旧条目会残留，但只有对应应用的 Copilot 打开时才会被引用，而那时它已经用新 url 覆盖注册，因此无害 |
| 重开旧聊天或重发旧消息 | 不继承历史 mcp 引用；只有当前宿主上下文会附加 |
| MCP 工具单次调用超过 2 分钟 | gateway 后端代理是透传管道，没有 120 秒期限（那个期限只用于 Desktop Bridge），受 Platform MCP `ReadTimeout` 约束 |

## 9. 内存与持久化边界

| 内容 | 存放位置 | 是否落盘 |
| --- | --- | --- |
| key → url 运行时表 | Platform `Registry.runtime` | 否 |
| MCP 连接、工具定义、同步状态 | Platform MCP Client / ToolSync | 否；`internal/mcp` 非测试代码中没有写文件调用 |
| 本次 Run 的工具集合 | `QuerySession.ToolNames` / `RuntimeMCPServerKeys` | 否；Run 结束即释放 |
| Desktop 注册状态 | `webapp-copilot-mcp.ts` 模块内 Map | 否 |
| `mcp.path` 声明 | WebApp 包内 `webapp.json` | 是，由应用作者静态声明，运行时不写 |
| 消息上的 `{type:"mcp",id}` | Platform 聊天记录 query line | 是，只作为痕迹，不参与装配 |

不修改 `agent.yml`、connector 目录、Desktop 设置、服务 `.env` 或 WebApp 数据根。

## 10. 安全边界

- **谁能挂 MCP**：只有持有 `scope=app` 宿主 token 的 Desktop。页面、WebClient、远程访客都无法注册。
- **谁能用 MCP**：只有请求中带了引用、且 key 已注册的 Run。引用由 Desktop Main 计算，页面不能指定其他应用的 key。WebClient 是 Desktop 内置的可信宿主页面。
- **为什么不额外校验 subject**：Platform 部署在本机、单用户；注册接口已强制宿主身份；所有已注册的 key 都属于本机已安装的应用。如果以后 Platform 改为多用户共享，需要在注册时记录 subject，并在准入时比对。
- **Platform 连到哪里**：只允许 `127.0.0.1`，不接受任意地址，避免把 Platform 当作 SSRF 跳板。
- **MCP 端点暴露面**：与应用后端其他接口相同，都通过 loopback gateway 访问。本机其他进程本来就能访问；LAN listener 是独立端口，不会自动暴露给局域网以外，但开启 LAN 访问后，该路径和其他后端路由一样对局域网可达。需要更强隔离的应用，应在后端自行校验。首版不提供宿主签发的 MCP 凭据。

## 11. 平台兼容

- macOS 和 Windows 共用同一个 loopback 地址 `127.0.0.1`。Desktop 明确发送 `127.0.0.1`，Platform 拒绝 `localhost`，避免 Windows 上 `localhost` 优先解析为 `::1`。
- key 计算是纯字符串哈希，与路径分隔符和大小写敏感的文件系统无关。
- 不涉及文件路径、进程或防火墙，因此不需要 `isMac`/`isWindows` 分支。验收时仍要在两个平台各跑一遍第 13.2 节。

## 12. 实施步骤与发布顺序

1. **Platform 单独验证（不发布）**
   - 实现 7.1–7.7。
   - 用一个本地 streamable-http MCP 示例服务，以 curl 带宿主 token 调用 PUT；再发一条带 `{type:"mcp"}` 引用的 query，确认模型能看到并调用工具；调用 DELETE 后确认旧 Run 调用失败、新 query 被拒绝。
2. **Desktop**
   - Manifest、契约生成、条目投影（5.1）。
   - 注册模块和触发点（5.2）、前台 IPC（5.3）、后台路径（5.4）。
   - 做一个带 `mcp` 的示例 WebApp 作为测试夹具（`contracts/webapp/fixtures`）。
3. **WebClient**：第 6 节。
4. **同批发布**：Desktop、WebClient 和 Platform 版本对齐。旧 Platform 不认识 `mcp` 引用：`NormalizeResourceReferences` 会原样放行，但 `ValidateReference` 会把它当作本地文件附件。Agent 关闭了本地文件附件时，整条消息会以 `interaction_disabled` 失败；开启时则静默没有工具。两种情况都不可接受，所以必须同批发布，不保留兼容分支。

## 13. 验收

### 13.1 自动验证

| 仓库 | 用例 |
| --- | --- |
| Platform | Registry：运行时条目在 `Reload()` 后仍然存在；Set/Remove 递增 version |
| Platform | ToolSync：运行时工具使用 `mcp_<hash>_` 命名并带 `runtimeServer`，不与内置工具重名 |
| Platform | 注册接口：缺少 app scope 或 deviceId 返回拒绝；非 `127.0.0.1` url、非法 key、超过上限、tools/list 失败分别返回对应错误；重复 PUT 是幂等的 |
| Platform | Session：直接模式和 tool mode 都能并入运行时键；子任务不并入；未就绪 key 返回 `mcp_binding_unavailable`；历史聊天的 mcp 引用不被继承 |
| Platform | Router：Run A 持有 key，Run B 未持有，B 通过别名或 `mcp_call` 调用时返回 `mcp_binding_not_mounted`；DELETE 后 A 的调用失败 |
| Platform | queryinput：steer、execute、automation 拒绝 mcp 引用 |
| Platform | interaction：关闭了全部附件开关的 Agent 仍然接受 mcp 引用 |
| Desktop | Manifest：`mcp` 缺少 backend、未命中前缀、落在保留前缀、路径含 `..` 都被拒绝；`webapp-contract:check` 通过 |
| Desktop | 投影：固定 copilot 与 userConfig agentKey 两个分支都会追加 mcp 引用；key 区分大小写和空格并且是确定的 |
| Desktop | 注册模块：并发 ensure 合并；停止触发 DELETE；Platform 不可用时不抛到 UI；url 使用 `runtime.webUrl` |
| Desktop | 后台 `assistant.chat`：传了 `skillIds` 时仍然保留 mcp 引用 |
| WebClient | 解析：非法 id、多于 1 条、agentKey 不一致时都被忽略；发送时带上 mcp；重发会去掉历史 mcp |

### 13.2 手工回归（macOS / Windows 分别执行，结果写入 `qa/manual-regression.md`）

1. 安装带 `mcp` 的示例 WebApp 并启动，打开 Copilot，输入框中出现锁定的 MCP 标签；请 Agent 调用应用工具，应用侧状态发生变化。
2. 同一个 Agent 先后在 A、B 两个应用的 Copilot 中运行，各自只能看到并调用自己应用的工具。
3. A 的 Run 正在进行时切到 B 并发送消息；A 的 Run 后续调用仍然落在 A。
4. 停止 A，A 的 Copilot 发送消息时显示明确的不可用错误，不会以空工具集静默运行。
5. 在 Desktop 中重启 agent-platform，不重新打开 Copilot 直接发送：能自动恢复（`reregisterAll` 已生效）。
6. 重开历史聊天并重发旧消息：不会自动挂上已停止应用的 MCP。
7. 检查 `agent.yml`、connector 目录和 Desktop 设置文件，没有新增或修改内容。

## 14. 文档更新（随实现同一变更提交）

- `docs/本地网站应用.md`：在“WebApp 数据能力与宿主认证”中 Copilot 固定资源那一段补充：应用可声明唯一的 MCP；Desktop 负责注册和注销的生命周期；Copilot 的每条消息由宿主附加引用；注入只存在于内存；不跨消息继承。
- `docs/智能助理集成.md`：Copilot 请求引用类型增加 mcp（如该文档描述了引用链路）。
- `docs/架构与模块边界.md`：新增的 Main↔Renderer IPC 与 webs→desktop-actions 端口是否需要登记，按该文档规则判断。
- `contracts/webapp/README.md`：`mcp` 字段说明和最小示例。
- Platform 仓库：`docs/连接器执行协议.md` 或 MCP 相关文档补充“运行时 server”来源与注册接口。

## 15. 风险与待确认

| 项 | 说明 | 处理 |
| --- | --- | --- |
| agent-platform 重启挂点 | Desktop services facade 目前没有现成的状态变化事件 | 实施时选定唯一挂点；ensure-on-open 作为兜底 |
| Platform 准入错误映射 | `mcp_binding_unavailable` 在哪一层转换为 query 错误响应 | 实施第 1 步确认，并让 WebClient 正确展示 |
| 实例选择 | Platform 存在全局与 Agent 作用域两套 Registry | 接到 ToolRouter 使用的那一套 |
| TEAM / 子任务 | 首版不继承 | 如果 Copilot Agent 是 TEAM，成员看不到这些工具；需要时另立方案 |
| gateway 对 MCP 的兼容性 | streamable-http 的 POST 响应与可选的 GET SSE 都需要透传 | 当前后端代理是 pipe，示例应用验证一次 |
| 应用重启后旧 Run 落到新实例 | 设计上接受 | 如需严格隔离，在 key 中加入实例代次 |

## 16. 核对来源

- Desktop：`src/shared/webapp-manifest.ts:360`（copilot schema）、`src/main/modules/webs/webapps/store.ts:366`（引用投影）、`src/renderer/app-shell/AppShell.tsx:1273`、`src/renderer/copilot/sidebar-copilot/AgentWebclientCopilotDock.tsx:42`、`src/main/modules/desktop-actions/action-dispatch.ts:102`、`src/main/modules/desktop-actions/webapp-platform-client.ts:8`、`src/main/modules/webs/webapps/runtime.ts:65`、`src/main/modules/webs/webapps/gateway.ts:28,273,695`、`docs/本地网站应用.md:203`。
- WebClient：`src/features/composer/components/HostRequiredSkillsContext.tsx`、`src/app/layout/CopilotShell.tsx:273`、`src/features/composer/components/ComposerArea.tsx:296,844`。
- Platform：`internal/runtime/session/session_builder.go:180,236,255,593,618`、`internal/runtime/session/chat_skills.go`、`internal/mcp/registry.go:55`、`internal/mcp/agent_registry.go:18`、`internal/mcp/agent_tools.go:12`、`internal/mcp/tool_sync.go:170,402,442`、`internal/mcp/types.go:13,55`、`internal/tools/tool_router.go:237,396`、`internal/tools/tool_mcp_gateway.go:46,74`、`internal/llm/llm_engine.go:103`、`internal/contracts/queryinput/references.go:57`、`internal/interaction/config.go:140`、`internal/runtime/query/query_interaction.go:27`、`internal/contracts/interfaces.go:360`、`internal/server/handler_connector_execution.go:17`、`internal/server/server_auth.go:49`、`internal/chat/query_line.go:74`。
