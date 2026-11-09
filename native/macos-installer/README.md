# macOS DMG 安装入口

DMG 中的 `Install <Product>.app` 是独立的 AppKit 应用，用户确认后负责复制校验、请求旧 Desktop 正常退出、外部进程复验、换包及打开新版。它使用 `<brand.appId>.installer`，避免 Finder 在旧版运行时将安装动作转发给主应用。

`scripts/lib/mac-dmg-installer.mjs` 在 Electron Builder 的 `afterSign` 阶段保留已有主应用验证，然后编译、签名并复验安装器。此时 Builder 导入的 CI 签名钥匙串仍可用。安装器读取同一品牌生成的 Info.plist，必须与主应用拥有相同的 Developer ID Application 发布者；最终 DMG 公证覆盖二者。安装器不进入在线更新 ZIP。

`InstallerCore.swift` 保持安装事务与 UI 分离，`main.swift` 只提供原生确认、进度和错误界面。文件事务的暂存与旧包备份位于 Applications 的独占目录中；先完整复制及验签，再停旧应用，确认 ACK 和进程退出后才移动目录。正常失败尽力恢复旧包，恢复或打开失败时保留备份。仅必要的文件操作通过 macOS 管理员授权执行，退出 helper 始终以当前用户运行。安装器不清理用户数据、不直接发送终止信号给 Desktop，也不承担服务配置升级。

新应用、安装器、暂存副本和最终发布副本始终要求正确品牌及同一 Developer ID Application 发布者。旧应用的“允许替换”策略与新代码来源验证分开：通常要求同一发布者；仅固定安装目标中的本机开发旧包可使用受限 ad-hoc 例外。该旧包必须非符号链接、由当前安装用户拥有、Info.plist 与 codesign 的品牌标识一致、明确使用无 Authority/Team 的 ad-hoc 签名，并通过完整 strict 验证。检查时捕获根可执行文件各支持架构的 CDHash；换包脚本在移动旧包前再检查所有权、品牌、ad-hoc 状态及已捕获的 CDHash。正式签名的其他发布者、损坏或未签名包、其他目录的 ad-hoc 副本继续拒绝。退出请求始终只执行新正式包的二进制，不执行旧开发包；此例外仅允许替换旧目标，不将旧包作为可信代码来源。

自动验证：

```sh
node --test test/mac-dmg-installer-packaging.test.mjs test/mac-dmg-installer-native.test.mjs
```

原生测试在 macOS 编译并执行 Swift，使用独立临时目录与 fixture，不退出或覆盖用户实际安装的应用。临时测试签名不能替代正式签名、公证 DMG 的 Finder 安装回归；发布检查见 `qa/manual-regression.md`。
