import AppKit

// This app has its own bundle ID. Finder must launch the installer even while
// another version of the product is running under the product's bundle ID.
final class InstallerDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var statusLabel: NSTextField?
    private var installing = false
    private let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? true
    private func text(_ zh: String, _ en: String) -> String { chinese ? zh : en }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        do {
            let configuration = try InstallerConfiguration(info: Bundle.main.infoDictionary ?? [:])
            let alert = NSAlert()
            alert.messageText = text("安装 \(configuration.productName)", "Install \(configuration.productName)")
            alert.informativeText = text(
                "将自动退出正在运行的应用、停止本地服务并安装到“应用程序”。正在运行的对话和未保存的编辑可能中断。应用数据会保留，安装后将自动打开。",
                "The running app and local services will close before installation in Applications. Running conversations and unsaved edits may be interrupted. Your app data will be kept and the app will open after installation.")
            alert.addButton(withTitle: text("退出并安装", "Quit and Install"))
            alert.addButton(withTitle: text("取消", "Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn else { NSApp.terminate(nil); return }
            installing = true
            showProgress(configuration.productName)
            let installer = MacDmgInstaller(configuration: configuration, installerURL: Bundle.main.bundleURL,
                runningApplications: {
                    DispatchQueue.main.sync {
                        NSWorkspace.shared.runningApplications.compactMap { app in
                            guard app.bundleIdentifier == configuration.bundleIdentifier, let url = app.bundleURL else { return nil }
                            return RunningInstallerApp(pid: app.processIdentifier, url: url)
                        }
                    }
                }, progress: { stage in
                    DispatchQueue.main.async { self.updateProgress(stage) }
                }, openApplication: { url in
                    _ = try checkedCommand(SystemInstallerCommands(), "/usr/bin/open", [url.path], timeout: 30)
                })
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try installer.install()
                    DispatchQueue.main.async { self.installing = false; NSApp.terminate(nil) }
                } catch {
                    DispatchQueue.main.async { self.showFailure(error) }
                }
            }
        } catch { showFailure(error) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Do not let an ordinary Dock Quit interrupt the two directory moves.
        installing ? .terminateCancel : .terminateNow
    }

    private func showProgress(_ product: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 150),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = text("安装 \(product)", "Install \(product)")
        let label = NSTextField(labelWithString: text("正在准备安装…", "Preparing installation…"))
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.frame = NSRect(x: 28, y: 90, width: 404, height: 24)
        let progress = NSProgressIndicator(frame: NSRect(x: 28, y: 58, width: 404, height: 14))
        progress.style = .bar
        progress.isIndeterminate = true
        progress.startAnimation(nil)
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(progress)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window; statusLabel = label
    }

    private func updateProgress(_ stage: InstallStage) {
        switch stage {
        case .preparing: statusLabel?.stringValue = text("正在复制并校验应用…", "Copying and verifying the app…")
        case .stopping: statusLabel?.stringValue = text("正在退出旧应用并停止本地服务…", "Closing the app and local services…")
        case .replacing: statusLabel?.stringValue = text("正在安装新版应用…", "Installing the new app…")
        case .opening: statusLabel?.stringValue = text("安装完成，正在打开应用…", "Installation complete. Opening the app…")
        }
    }

    private func showFailure(_ error: Error) {
        installing = false
        window?.orderOut(nil)
        if case InstallerFailure.authorizationCancelled = error { NSApp.terminate(nil); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = text("安装未完成", "Installation did not complete")
        switch error {
        case InstallerFailure.shutdownFailed, InstallerFailure.shutdownTimeout, InstallerFailure.processesRunning:
            alert.informativeText = text("旧应用或本地服务未能完成退出，已停止覆盖安装。请重新打开应用后重试。", "The app or local services could not finish closing. Installation has stopped. Reopen the app and try again.")
        case InstallerFailure.anotherUser:
            alert.informativeText = text("其他登录用户仍在使用此应用。请先让该用户退出应用，再重试安装。", "Another logged-in user is running this app. Ask them to quit it before installing.")
        case InstallerFailure.alreadyInstalling:
            alert.informativeText = text("另一个安装窗口正在安装此应用，请等待安装完成。", "Another installer is installing this app. Wait for it to finish.")
        case InstallerFailure.invalidPackage, InstallerFailure.invalidSignature, InstallerFailure.unsafeDestination:
            alert.informativeText = text("无法验证安装包或已有应用。请从完整的官方安装盘运行“安装”应用。", "The installer or existing app could not be verified. Run Install from the complete official disk image.")
        case InstallerFailure.recoveryRequired(let location):
            alert.informativeText = text("安装或打开应用失败。旧应用备份已保留，请保留此目录以便恢复：\n", "Installation or launch failed. A previous app backup has been kept for recovery:\n") + location
        default:
            alert.informativeText = text("无法完成文件安装。请确认磁盘空间与“应用程序”目录权限后重试。", "The app files could not be installed. Check disk space and permission to write to Applications, then try again.")
        }
        alert.addButton(withTitle: text("关闭", "Close"))
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = InstallerDelegate()
application.delegate = delegate
application.run()
