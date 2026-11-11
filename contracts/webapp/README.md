# WebApp SDK 接入

机器契约由 `npm run webapp-contract:generate` 从源码生成；`webapp-contract:check` 检查漂移。`bridge.mjs` 与运行时 `/__desktop/bridge.js` 内容一致，生成文件不能手改。

Manifest v2 的 `target` 包含 `linux-x64`，供 Linux Compose 包表达目标平台；不支持 `linux-arm64` 或 `linux-amd64` 别名。Desktop 识别语法后仍按本机平台拒绝 Linux 包。`fixtures/manifest-v2.json` 保存可复用的完整合法/非法输入（`schemaVersion: 1`，每个 case 的 `valid` 仅表示 Manifest 语法校验结果），由源码与生成 validator 共同验证；包内文件和宿主能力需要另外校验。Platform 安装器尚未实现，后续接入时应消费相同 fixture，不把该契约更新视为托管能力交付。

浏览器：

```js
import { connector, desktop, agent, skill, artifact, kanban, automation }
  from '/__desktop/bridge.js';

// 安装即信任，可直接调用；连接器账号仍需登录。
const result = await connector.invoke({
  connectorId: 'wecom', adapter: 'cli',
  args: ['calendar', 'schedules', 'list', '--json', JSON.stringify({
    begin_time: '2026-09-19 00:00:00', end_time: '2026-09-19 23:59:59'
  })]
});
if (result.exitCode !== 0) throw new Error('CLI failed');
const output = JSON.parse(result.stdout); // 应用继续检查业务错误码。
```

WebApp 安装即获得宿主公开能力，无需 `desktopBridge` 能力声明或 `desktop.requestAccess()`。旧 Manifest 字段仍可解析但不限制访问；旧 `requestAccess()` 作为兼容入口直接返回 granted，不弹窗、不要求用户手势。CLI/MCP 执行可读写及发送消息，不提供操作系统沙箱。

CLI 请求为 `{connectorId,adapter:"cli",args:string[],idempotencyKey?,credentialRevision?}`；返回 `{invocationId,connectorId,adapter,credentialRevision,exitCode,stdout?,stderr?}`，输出未经业务投影，WebApp 按连接器语义处理且不自动显示原始诊断。调用者不能指定可执行路径、环境或工作目录。

MCP 请求为 `{connectorId,adapter:"mcp",component,toolName,arguments,idempotencyKey?,credentialRevision?}`；返回相同身份字段及 `mcp` 原生结果（content/structuredContent/isError），不要求只有结构化对象。只访问已配置组件和实际存在、未禁用工具，禁止自定义 URL。

`connector.list()` 读取 Platform 的 `/api/connectors` 使用目录，默认连接器由 Platform 过滤，返回 `{items:[{connectorId,name}]}`；列表不包含版本或 adapter 信息。需要执行详情时按需调用 `connector.describe({connectorId})`，返回 revision、adapters、components。revision 为描述信息，执行端自己冻结并复核包指纹，不要求应用维护业务 operation revision。

收到 `connector_auth_required` / `connector_auth_expired` 后显示登录按钮，在新的用户点击中调用 `desktop.authenticateConnector({connectorId})`，只得到 `{status:'authorized'|'cancelled'|'failed'}`。认证接口不接受 URL、回调、账号或 token。成功后由业务显式重试原只读请求；SDK 不自动重放。

Node 后端将生成的 `bridge.mjs` 随应用复制到后端目录：

```js
import { createBackendClient } from './bridge.mjs';
const { connector, agent, skill, artifact, kanban } = createBackendClient({
  url: process.env.DESKTOP_ACTION_BRIDGE_URL,
  token: process.env.DESKTOP_ACTION_BRIDGE_TOKEN
});
```

仅受管后端使用 Desktop 注入的 loopback URL 与 token；不得转发至前端或日志。Node SDK 不依赖 DOM。连接器 list/describe/invoke 在前后端使用相同契约与短期应用授权，CLI/MCP 均支持；UI 登录、兼容权限入口、产物预览/保存和其他原生交互仍只允许页面调用。后端业务 API 必须校验访问者，不得公开转发任意 connector 请求或让远程访客隐式继承本机账号。官网账号变化不撤销本地调用身份；本地服务身份或应用实例失效后应重新建立调用。

| 能力 | 当前接口与约束 |
| --- | --- |
| Agent | `agent.query(message)` 或 `agent.query({message,skillIds?,background?})`；默认返回 `{text,agentKey,chatId,runId}`，后台返回 `{accepted,chatId,runId}` |
| 结构化执行 | `agent.execute({message,input?,outputSchema,agentKey?,chatId?,references?},{signal?})`；页面/后端共用，同步返回 `{chatId,status,output|reason}` |
| 运行 | `agent.observe({runId,cursor?},{signal?})` 异步迭代精简事件；`agent.interrupt({runId})`，只操作本应用后台运行 |
| 技能 | `skill.list()`、`skill.describe({skillId})`；读取 Platform 实际技能目录的安全元数据，`agentHasSkill` 按当前宿主选定 Agent 返回；不要求固定 Copilot 或包内技能声明 |
| 产物 | `artifact.list({chatId,runId?,cursor?,limit?})`；`get/read/open/saveAs({chatId,runId?,artifactId})`；只允许当前应用实例发起的 Chat |
| 看板 | 安装后直接调用；`kanban.boards.list()`、`kanban.issues.list({projectId?,cursor?,limit?})`、`kanban.issues.get({issueId})` |
| 宿主 | `desktop.capabilities.list/has`、`desktop.app.getConfig/getUserConfig`、`desktop.theme.get/set`、`desktop.locale.get/set`、browser、dialog、microphone、clipboard.writeText、notification |
| 聊天预览 | `desktop.chat.open({chatId})` → `{chatId,status:"opened"}`；按 Chat ID 打开 WebClient 只读历史弹窗，不发起 Run |
| Copilot | `desktop.copilot.get()`、`desktop.copilot.open()`、`desktop.copilot.close()` → `{open:boolean}`；幂等控制当前应用已有的 Copilot，沿用 Agent、引用及会话 |
| 预留 | `automation.*`、desktop.screen.capture、clipboard.readText、file.reveal、window、camera、share；调用抛 `not_implemented` |

主题和语言设置只向本机 WebApp 页面开放，复用 Desktop 的设置持久化与界面更新；不要求 Manifest 声明或额外授权。托管后端 SDK、局域网和发布页面不能调用。能力检测使用 `desktop.capabilities.has('desktop.theme')` 与 `desktop.capabilities.has('desktop.locale')`。

```js
const theme = await desktop.theme.get(); // { themeMode, resolvedTheme }
await desktop.theme.set({ themeMode: 'dark' }); // light | dark | system
const language = await desktop.locale.get(); // { locale, source }
await desktop.locale.set({ locale: 'en-US' }); // zh-CN | en-US
```

设置改变整个 Desktop，并在重启后保留。页面可用 `theme.get()` 回读偏好，`resolvedTheme` 是当前实际明暗；`system` 不会被改写为具体明暗。语言切换返回 Desktop 的语言状态，不会自动翻译 WebApp 文案，应用自行维护词典并按 `locale.get()` 同步。写入失败通过 `DesktopBridgeError` 返回，不能自行当作已保存。

后台运行示例：

```js
const { chatId, runId } = await agent.query({
  message: '生成报告', background: true, skillIds: ['report-writer']
});
const controller = new AbortController();
for await (const event of agent.observe({ runId }, { signal: controller.signal })) {
  if (event.type === 'text.delta') renderText(event.text);
}
const { items } = await artifact.list({ chatId, runId });
if (items.length) await artifact.open({ chatId, runId, artifactId: items[0].artifactId });
```

技能 id 必须在应用固定 `copilot.references` 的 `type:"skill"` 引用中，未传时使用声明的技能集；Agent 由固定 Copilot、用户配置或 Desktop 默认助手选择，页面可通过可选 agentKey 选择当前目录中的智能体。事件含单调 `cursor`；当前缓存最多 256 条、128 个运行、保留 30 分钟。游标过期返回 `event_cursor_expired`，不要据此重新提交 Agent 请求。订阅停止不等于停止运行。当前产物 Chat 归属只保留当前应用实例，尚不恢复历史 Chat。

上述技能引用限制仅针对 `agent.query` 的附加 `skillIds`，不限制 `skill.list/describe` 的目录读取。技能目录对本机页面与受管后端同样开放，只返回 `skillId/name/description?/agentHasSkill`；不返回安装路径、正文、凭据或任意执行入口。挂载状态与 chat/execute 共用现有用户配置、固定 Copilot、Desktop 默认助手的选择机制；调用方可传可选 agentKey，宿主校验当前目录。列表为空是正常结果，非法目录响应或实例/身份在读取期间失效时拒绝交付。

`artifact.read()` 返回 `ReadableStream<Uint8Array>`，内部是最多 1 MiB 的有界缓冲；`saveAs` 同样受此上限约束。超限返回 `artifact_too_large`。预览成功为 `{opened:true}`；另存为返回 `{saved:true}` 或 `{cancelled:true}`，不返回绝对文件路径。Platform 不存在全局产物列表时，SDK 不模拟全局列表。

错误统一为 `DesktopBridgeError`，可读取 `code` 和 `action`。实例或本地服务身份失效返回 `app_grant_required`；连接器未登录仍返回认证错误。`capabilities.has()` 表示接口可用；连接器和看板能力的 `declared` 为 true、`permission` 为 not_required，系统麦克风等 OS 权限独立处理。

连接器登录无需 `connectorAuthentication` 声明，直接调用 `desktop.authenticateConnector({connectorId})`。认证复用现有 config，不创建额外凭据目录。

## 结构化执行与取消

```js
const controller = new AbortController();
const result = await agent.execute({
  message: '提取订单金额，无法识别时提交 failure。',
  input: { text: '订单总额 128 元' },
  outputSchema: {
    type: 'object', properties: { amount: { type: 'number' } },
    required: ['amount'], additionalProperties: false
  }
}, { signal: controller.signal });
// 用户点击取消时调用 controller.abort()。
if (result.status === 'success') useAmount(result.output.amount);
else showReason(result.reason);
```

```js
// 页面与受管后端使用相同参数；上传和执行应选择同一个 Agent。
const { chatId, upload } = await agent.upload({ file, name: file.name, agentKey: 'invoice-agent' });
const result = await agent.execute({
  agentKey: 'invoice-agent', chatId, references: [upload],
  message: '提取附件中的金额', outputSchema: { type: 'object' }
});
```

受管后端使用 createBackendClient 返回的同名方法。目标必须是有效工具带 result_submit 的 Native Agent；EXECUTOR 模板通常符合，但不按 mode 授权。沿用现有用户 Agent 选择、固定 Copilot 和 Desktop helper 选择机制；默认 helper 未必支持执行，宿主不自动换 Agent。execute 不自动注入 Manifest copilot.references；显式 references 的资源语义与准入由 Platform 判定。

接受 message、input、outputSchema 以及可选 agentKey、chatId、references；拒绝 skillIds、accessLevel、background 和任意路由。chatId 必须属于当前应用实例，可使用 upload、query 或 execute 返回的 Chat。references 沿用 Platform Reference JSON 字段（type、id、name、url、mimeType、sizeBytes、text、annotation、annotationIndex、path、sha256、meta）；chat 类型引用同样校验应用归属，资源有效性由 Platform 判定。上传后将返回的 chatId 与 upload 引用一起传给 execute，即可使用附件。权限固定 ask_for_approval，不提供问答或审批 UI。审批返回 approval_required；Agent 主动提问可能等待直至取消/超时。input 为标准 JSON，不支持 Blob、multipart、$file、自定义 toJSON、循环或非有限数；input/schema 各从自身根节点计数，最多 64 层。显式 input:undefined 视为省略，嵌套 undefined 仍拒绝。

message 最多 12,000 个 UTF-16 code unit；outputSchema 根为 object，序列化最多 64 KiB。完整页面请求体最多 64 KiB，完整后端请求体最多 256 KiB，因此页面实际可用 schema 大小还需扣除其他字段。Platform 完整响应最多 1 MiB。Main 执行期限十分钟，传输层留十五秒余量；全局最多八个在途执行，同一 WebApp 最多两个，两入口共享额度，不排队。

长请求和取消使用独立 Node HTTP socket，不占默认 Chromium session 的同源连接池。运行期每十五秒兜底探测身份，同宿主短窗口合并；临时状态查询/续签失败不取消任务，真正的 grant、实例或主体变化仍撤销，交付前严格复验。Push 连接在后台准备，不阻塞执行请求。

status:failure 是正常业务结果，不抛异常。请求失败抛 DesktopBridgeError：unsupported Agent 为 assistant_agent_unsupported，Agent 不可用为 assistant_agent_unavailable，缺失/非法交卷为 output_missing/output_invalid，超时为 assistant_timeout，超大结果为 assistant_result_too_large，主动取消为 cancelled。无执行路由为 assistant_execute_unavailable，不回退到 chat。

AbortSignal 仅控制本次执行，包含响应体读取阶段。Main 获取当前同主体、同 endpoint 的新 token，使用与本次 requestId/Agent 关联的 canonical Run 经独立 HTTP /api/interrupt 主动中断，并始终 abort execute；还没收到 Run 标识时由断开连接触发 Platform 中断。agent.interrupt/subscribe 仍只用于原 chat 后台 Run。页面刷新、应用停止、实例失效和 Desktop 退出同样取消；隐藏或展示转移不主动取消，页面关闭也不取消独立后端调用。

连接拒绝和 Platform 明确的参数/Agent 准入拒绝在 details.executionState 标为 not_started，无法确认是否执行的异常标 unknown。日志只记关联标识、阶段、耗时和稳定错误码，不记任务/结果正文或 token；interrupt 非成功 HTTP/业务 ack 记录 assistant_interrupt_failed。

Schema 合法只证明交卷形状通过，不证明外部副作用或所有后续步骤成功。取消不回滚已执行操作；接口没有 requestId 去重，SDK 从不自动重发。output 原样返回；@chat 路径不是 artifactId，只有真实已发布产物能经 artifact.list/get/read 获取。

## 重试与执行回执

SDK 不自动重试。应用为发送等有副作用请求提供稳定 idempotencyKey，Platform 在执行前落盘 claim，完成后保存原始结果；同键同请求返回收据，不同参数冲突，未完成 claim 返回 invocation_outcome_unknown。退出码非零和 MCP isError 仍是可回放的执行结果，不代表肯定未产生副作用。无幂等键调用不提供去重保障。

credentialRevision 是不含凭据的账号状态版本，可在连续业务调用中回传；登录变化后执行前拒绝。超时、输出超限或响应丢失后不能换键自动重发。CLI 输出不是凭据保密沙箱；应用获得执行权限后可使用该 CLI 自身提供的数据功能。

## 升级

旧 operationId、connectorOperations、connectorWrite 契约不恢复，旧 operationId 请求返回 connector_contract_upgrade_required。现有 connectorExecution、connectorAuthentication、kanbanRead 字段仅兼容解析，新包可省略整个 desktopBridge。Bridge v1/v2 不再作为能力门控；宿主与 Platform 内部短期 grant 请求仍使用 version:2，无需应用申请或持有该凭据。

## 网站认证：`auth.createSession`

`auth` 是第八个顶层作用域，与 `agent`、`connector`、`desktop` 并列。页面可先用 `auth.isAvailable()` 检测宿主认证传输是否存在，再在启动时或用户点击时调用。该检测不代表已登录或获准；Main 仍验证真实 Surface 并请求原生同源授权：

```js
import { auth } from '/__desktop/bridge.js';
await auth.createSession({ exchangePath: '/api/auth/session' });
const user = await fetch('/api/me').then(response => response.json());
```

只接受 `exchangePath`：以 `/` 开头的同源绝对路径，不接受 URL、查询、片段、路径回退或 `/__desktop/`。成功只返回 `{ok:true}`，失败抛 `DesktopBridgeError`。常见 code：`unavailable`、`forbidden`、`insecure_origin`、`cancelled`、`sign_in_required`、`context_changed`、`busy`、`exchange_rejected`、`invalid_cookie`、`cookie_conflict`、`exchange_failed`。

Main 通过原生对话框展示精确交换地址，本次允许后才读取当前 SSO token。请求固定为 `POST`、`Authorization: Bearer`、JSON `{}`、同源 `Origin`，不带旧 Cookie，不跟随重定向；网站 401 不触发 Desktop 续期，仅在 Identity 已独立发布新 token 时使用新值重试一次。服务端必须自行验签、校验 issuer/audience/有效期/权限，再响应 2xx 和 1–4 个 `Set-Cookie`。响应正文不向页面透传。

Cookie 要求：host-only（不得声明 Domain）、`Path=/`、`HttpOnly`、`SameSite=Lax` 或 `Strict`；HTTPS 必须 Secure。本机正在运行的 WebApp gateway 的 HTTP loopback 允许不带 Secure，从内置 Browser 或普通 WorkPanel 打开该地址也可使用；任意其他 loopback 服务和远端 HTTP 不允许。Cookie 有效期不超过 token 到期及八小时，服务端可进一步缩短。请使用应用专属且适当区分 origin 的 Cookie 名；Cookie 本身不按端口隔离，桥不会覆盖不属于它管理的已有 Cookie。

认证通过访问者页面的专用 preload/IPC 执行，不经过发布者的 HTTP Action Bridge。`createBackendClient()` 不暴露 `auth`，公开 Desktop Action 与 WebApp backend/page HTTP token 都不能调用这个入口。页面离开、guest 销毁或身份撤销会中止在途操作；退出清理本能力登记的 Cookie，重启也清理这些会话，不清空其他站点数据。网站自己的退出、会话查询和业务权限归网站后端。

发布页面可将生成的 `bridge.mjs` 作为普通静态 ES Module 随应用提供，仍调用访问者 Desktop 的 preload。访问者可在内置 Browser、普通 WorkPanel 网络网页或 Website 中直接打开 HTTPS 地址，不要求安装 WebApp 或登记网站；系统外部浏览器、Help、Service、文档/文件预览和 iframe 不获得此入口。只有该认证能力可在远端使用，其他本地 SDK 能力不随发布开放。

## 打开历史聊天与 Copilot

```js
import { desktop } from '/__desktop/bridge.js';
await desktop.chat.open({ chatId }); // 例如 agent.execute/chat 返回的 chatId
const { open } = await desktop.copilot.get();
await desktop.copilot.open();
await desktop.copilot.close();
```

这些方法仅供主工作区当前 WebApp 的本机页面使用，不需要额外 Manifest 声明；后台应用或独立窗口调用返回 `webapp_ui_unavailable`，应先在主工作区打开该应用。后端、局域网、发布页面和通用 Desktop Action 不能调用。SDK capability ID 为 `desktop.chat`、`desktop.copilot`。历史弹窗仅接受 Chat ID，不接受 URL、Agent 或 Run 控制参数；关闭或切换应用后释放预览。弹窗期间让出 Copilot 的活动观察者，关闭后恢复已有 Dock。get 只读取当前应用实际显示的面板状态，不打开面板或创建会话；切换前应回读该状态，避免用户从面板内关闭后误判。Copilot 被页面设置禁用时，open 返回 `copilot_disabled`；重复 open 不新建或重置会话，close 不停止后台 Run。

认证 SDK 的 `auth` 接口与品牌无关，自动发现访问者自己的 ZenMind/CuteJ preload；不要由 WebApp 直接读取品牌全局，也不要用发布者品牌判断登录能力。


### 附件、资源和运行控制（Desktop）

- `agent.upload({file: Blob, name?, chatId?}, {signal?})`：单文件最多 64 MiB（67,108,864 字节）。省略 chatId 时由 Platform 在上传时创建 Chat，SDK 返回该 canonical chatId；传入本实例已有 chatId 则上传到原 Chat，返回 `{chatId, upload:{type,id,name,url,mimeType,sizeBytes}}`，不返回本机路径。
- `agent.query({message, chatId?, uploadIds?, skillIds?, background?})`：在本实例拥有的 Chat 续聊；uploadIds 最多 16 个，必须属于同一 Chat 和实例，上传句柄 30 分钟有效。
- `agent.resource.read({chatId,file}, {signal?})`：file 是 Chat 相对路径，返回 `ReadableStream<Uint8Array>`，有界读取最多 16 MiB；不接受 URL、绝对路径或隐藏内部文件。已发布产物下载仍用 artifact.read/saveAs。
- `agent.steer({runId,message,requestId?,steerId?})`、`agent.send({runId,message,requestId?})`、`agent.submit({runId,awaitingId,submitId?,param?|params?})`：仅本实例后台 Run，根 Agent 由宿主固定。send 返回 mailbox 回执，不自动订阅回执中的新 Run；调用方应保留 requestId 防止重复投递。submit 的 param 与 params 必须二选一。
- `agent.interrupt({runId})` 走 Primary WebSocket 控制通道。

上传使用独立的 88 MiB JSON 传输限额入口（容纳 64 MiB 文件的 Base64 与元数据），普通页面 Action 仍为 64 KiB，后端仍为 256 KiB。页面与托管后端均支持这些数据方法。Compose 宿主须另外实现对应处理器和上传入口，不能仅复制 SDK 认定可用。


### 智能体目录与默认值（Desktop）

`agent.list()` 返回 `{items:[{agentKey,name,role}],defaultAgentKey}`，页面与托管后端均可调用，响应不包含提示词、路径或凭据。`agent.query/execute/upload`、`skill.list/describe` 可传可选 agentKey，显式选择必须仍在当前目录。省略时使用宿主已有配置；列表失败不伪造目录，显式选择不可用时直接报错。已有 Run 的 steer/send/submit/interrupt 继续使用创建时固定的根 Agent，不接受重新指定。execute 资格由 Platform 判定，不能因所选 Agent 不支持 result_submit 自动切换。Compose 托管桥尚未实现这项选择能力。

## Agent 规范命名（Desktop）

新应用使用 `agent`：`list()`、`query(message | {message,agentKey?,chatId?,uploadIds?,skillIds?,background?})`、`execute(...)`、`observe({runId,cursor?},{signal?})`、`interrupt`、`steer`、`send`、`submit`、`upload`、`resource.read`。页面具名导出和 `createBackendClient().agent` 同名。`agent.query` 默认等待文本结果，background:true 返回受理身份；当前不返回流。`agent.observe` 异步迭代文本/状态，内部调用 `agent.events`，仅有界缓存续读，不是持久 attach，不因解除观察而停止运行。资源、附件与控制的参数及限额沿用上述 Desktop 契约；已有 Run 始终使用创建时根 Agent。

`agent` 不提供 chat、stop、subscribe 或 image。旧 `assistant.*` 继续作为废弃兼容入口，包含旧 stop/image；既有应用无需立即迁移。旧 image 固定 zenmi，是 Image Studio 适配，不能用作通用 Agent 或图像模型能力。新应用通过 upload→query→resource/artifact 完成文件闭环；蒙版上传只形成附件，原生编辑需要具体图像工具和模型支持，不提供通用 mask 参数。Compose 独立宿主尚未同步这些规范 Action 与新增数据/控制能力，不可仅更新 SDK 即宣称可用。

```js
import { agent } from '/__desktop/bridge.js';
const { items, defaultAgentKey } = await agent.list();
const accepted = await agent.query({ message: '生成报告', background: true });
for await (const event of agent.observe({ runId: accepted.runId })) {
  if (event.type === 'text.delta') renderText(event.text);
}
```
