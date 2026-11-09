# WorkPanel 原生 HTML 草稿预览

状态：已按用户确认开始实施（2026-11-09），替代 PR #250 初稿中的生命周期与失败回落规则。

## 范围

Desktop 与 Agent WebClient 同批改造。复用现有 document-html 隔离预览、批注与统一 WorkPanel；不新增源码编辑器、保存、发布、正式资源或恢复机制。Standalone 和旧宿主保持既有 blob 预览。

## 已确认的交互

- HTML 代码块预览进入 Desktop WorkPanel。
- 同正文复用标签，正文变化打开新标签，旧预览继续可用。
- 批注交给所属 Chat 的输入框，不自动发送；智能体在回复中提供修订后的 HTML 代码块，用户重新预览。
- **刷新即清空，不恢复。** 来源 WebClient 文档刷新或销毁、Desktop renderer 刷新均撤销临时草稿与批注；不忽略或迁移 generation。
- 草稿没有文件地址、保存、定位、外部应用打开和 document.commit 能力。

## 边界与修订

- canonical bridge 保持 v6，以新增 capability 探测兼容。
- 新 html-draft 来源包含 Agent、Chat、HTML、SHA-256 与建议名；Main 校验结构、UTF-8 字节数并重算摘要。
- 稳定身份只取 Agent、Chat 和正文摘要，文件名不参与去重。同内容复用时保留已有文件，避免重写导致闪烁或清理竞态。
- 单份最多 4 MiB，总正文最多 32 MiB，全部 handle 与 pending claim 最多 16 个；关闭或取消释放额度。
- 草稿协议只读取自身文件；复用独立临时 session，不继承 SSO、Node 或通用 Desktop bridge。
- Main 从真实发起 guest 绑定来源文档生命周期；同文档 SPA 导航不当作刷新，顶层文档替换和销毁撤销。迟到 claim 和迟到 renderer 打开结果不能复活草稿。
- 批注携带 SHA-256 和正文有界开头片段供定位；不承诺自动修改历史消息。
- 无能力与明确不支持时可回落。宿主授权、校验、超限与 I/O 失败明确停止，不换通道继续预览。
- 写入失败、claim 失败、未认领超时和正常退出均清理；崩溃残留不恢复，不声称崩溃时完成物理删除。

## 验证与发布

两端契约镜像、类型检查、边界检查、国际化检查及相关自动测试必须通过。macOS/Windows 手工验收按 qa/manual-regression.md 执行。两端代码与 WebClient Program Bundle 须同批交付；源码构建通过不等于运行中的内置资源已经更新。
