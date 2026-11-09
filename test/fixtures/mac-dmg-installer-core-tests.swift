import Foundation
import Darwin

private enum CheckFailure: Error { case assertion(String) }
private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw CheckFailure.assertion(message) }
}
private let system = SystemInstallerCommands()
private let fm = FileManager.default
private let identifier = "cc.cutej.installer.fixture"
private func run(_ program: String, _ arguments: [String]) throws -> CommandResult {
    try system.run(program, arguments, timeout: 15)
}
private func makeApp(_ url: URL, marker: String) throws {
    try fm.createDirectory(at: url.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
    try fm.createDirectory(at: url.appendingPathComponent("Contents/Resources"), withIntermediateDirectories: true)
    try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: url.appendingPathComponent("Contents/MacOS/Fixture"))
    let info: [String: Any] = ["CFBundleIdentifier": identifier, "CFBundleExecutable": "Fixture",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.5.43", "CFBundleVersion": "0.5.43"]
    let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try data.write(to: url.appendingPathComponent("Contents/Info.plist"))
    try marker.write(to: url.appendingPathComponent("Contents/Resources/marker.txt"), atomically: true, encoding: .utf8)
    let signed = try run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, "--timestamp=none", url.path])
    try expect(signed.status == 0, "fixture signing failed: " + String(decoding: signed.output, as: UTF8.self))
}
private func marker(_ url: URL) throws -> String {
    try String(contentsOf: url.appendingPathComponent("Contents/Resources/marker.txt"), encoding: .utf8)
}
private func configuration(_ product: String = "安装 Fixture's $(touch injected)") throws -> InstallerConfiguration {
    try InstallerConfiguration(info: [
        "DesktopProductName": product, "DesktopBundleIdentifier": identifier,
        "DesktopStorageNamespace": "cutej-installer-fixture-\(getpid())", "DesktopShutdownArgument": "--desktop-shutdown-for-update",
        "DesktopRuntimeRootDirName": ".cutej-installer-fixture", "DesktopDataSubdirectory": ".desktop",
        "DesktopProgramDataDirName": "CuteJ Installer Fixture", "CFBundleShortVersionString": "0.5.43"
    ])
}

// Developer ID signatures are never forged or generated here. The complete-flow
// tests isolate that trust check, tested separately below with real ad-hoc bundles,
// while running the production ditto/rename/rollback scripts and ACK parser.
private final class FixtureCommands: InstallerCommands {
    var ackStatus = "OK"
    var ackMode = "installer"
    var ackOK = true
    var snapshotText: String?
    var sourceExecutable = ""
    var shutdownCalled = false
    var stoppedPid: Int32?
    var events: [String] = []
    var failStageSignature = false
    var wrongTeam = false
    var authorizationCalls = 0
    var cancelAuthorizationAt = 1
    var realSignaturePaths: Set<String> = []
    var foreignPublisherPaths: Set<String> = []

    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult {
        if executable == "/usr/bin/osascript" {
            authorizationCalls += 1
            if authorizationCalls == cancelAuthorizationAt {
                return CommandResult(status: 0, output: Data("CANCELLED\n".utf8))
            }
            guard let script = arguments.last else { throw CheckFailure.assertion("missing authorized script") }
            // Execute the allowed step as the test user; no real elevation prompt.
            return try run("/bin/bash", ["-c", script], timeout: timeout)
        }
        if executable == "/usr/bin/codesign" {
            if let path = arguments.last, realSignaturePaths.contains(path) {
                return try system.run(executable, arguments, timeout: timeout)
            }
            if arguments.contains("--display") {
                let app = arguments.last ?? ""
                let id = app.contains("Install Fixture.app") ? identifier + ".installer" : identifier
                let team = (wrongTeam && app.contains("Install Fixture.app")) || foreignPublisherPaths.contains(app) ? "OTHERTEAM" : "TESTTEAM"
                return CommandResult(status: 0, output: Data("Identifier=\(id)\nTeamIdentifier=\(team)\nAuthority=Developer ID Application: Fixture\nCDHash=abcdef012345\n".utf8))
            }
            return CommandResult(status: 0, output: Data())
        }
        if executable == sourceExecutable {
            shutdownCalled = true; events.append("shutdown")
            if let pid = stoppedPid {
                kill(pid, SIGTERM)
                let deadline = Date().addingTimeInterval(2)
                while kill(pid, 0) == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            }
            let prefix = "--desktop-shutdown-ack="
            guard let arg = arguments.first(where: { $0.hasPrefix(prefix) }) else { throw CheckFailure.assertion("missing ACK") }
            let ack = URL(fileURLWithPath: String(arg.dropFirst(prefix.count)))
            let report = try JSONSerialization.data(withJSONObject: ["mode": ackMode, "ok": ackOK])
            try Data((ackStatus + "\n" + String(decoding: report, as: UTF8.self) + "\n").utf8).write(to: ack)
            return CommandResult(status: 0, output: Data())
        }
        if executable == "/bin/ps", let text = snapshotText {
            return CommandResult(status: 0, output: Data(text.utf8))
        }
        if executable == "/bin/bash", arguments.count == 2 {
            var script = arguments[1].replacingOccurrences(of: "/usr/bin/codesign --verify", with: "/usr/bin/true")
            if script.contains("/usr/bin/ditto") {
                events.append("copy")
                if failStageSignature { script += "\n/usr/bin/false\n" }
            } else if script.contains("backed_up=0") { events.append("replace") }
            return try system.run(executable, [arguments[0], script], timeout: timeout)
        }
        return try system.run(executable, arguments, timeout: timeout)
    }
}

@main
private struct InstallerCoreChecks {
    static func main() throws {
        let root = fm.temporaryDirectory.appendingPathComponent("installer-checks-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        var checks = 0
        func check(_ label: String, _ body: () throws -> Void) throws {
            do { try body(); checks += 1; print("PASS \(label)") }
            catch { fputs("FAIL \(label): \(error)\n", stderr); throw error }
        }
        func transaction(_ label: String) throws -> InstallFileTransaction {
            let directory = root.appendingPathComponent(label)
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            let source = directory.appendingPathComponent("新包 ' $(touch injected).app")
            let dest = directory.appendingPathComponent("旧包 ' $(touch injected).app")
            try makeApp(source, marker: "new"); try makeApp(dest, marker: "old")
            return InstallFileTransaction(source: source, destination: dest, workspace: directory.appendingPathComponent(".stage ' 空格"),
                                          requirement: "identifier \"\(identifier)\"")
        }
        func execute(_ script: String) throws -> Int32 { try run("/bin/bash", ["-c", script]).status }
        func fullFixture(_ label: String, configure: (FixtureCommands) -> Void = { _ in },
                         running: @escaping () -> [RunningInstallerApp] = { [] },
                         open: @escaping (URL) throws -> Void = { _ in }) throws -> (MacDmgInstaller, FixtureCommands, URL) {
            let directory = root.appendingPathComponent(label)
            let volume = directory.appendingPathComponent("volume")
            let applications = directory.appendingPathComponent("Applications")
            try fm.createDirectory(at: volume, withIntermediateDirectories: true)
            try fm.createDirectory(at: applications, withIntermediateDirectories: true)
            let config = try configuration()
            let source = volume.appendingPathComponent(config.productName + ".app")
            let destination = applications.appendingPathComponent(config.productName + ".app")
            try makeApp(source, marker: "new"); try makeApp(destination, marker: "old")
            let helper = volume.appendingPathComponent("Install Fixture.app")
            try fm.createDirectory(at: helper, withIntermediateDirectories: true)
            let commands = FixtureCommands()
            commands.sourceExecutable = source.appendingPathComponent("Contents/MacOS/Fixture").path
            configure(commands)
            let installer = MacDmgInstaller(configuration: config, installerURL: helper, destinationDirectory: applications,
                home: directory.appendingPathComponent("home"), commands: commands, runningApplications: running,
                progress: { _ in }, openApplication: open)
            return (installer, commands, destination)
        }

        try check("signed staging preserves the old bundle and quotes Unicode shell paths") {
            let tx = try transaction("staging")
            try expect(try execute(tx.prepareScript) == 0, "prepare failed")
            try expect(try marker(tx.destination) == "old", "old app changed during staging")
            try expect(try marker(tx.staged) == "new", "staged content missing")
            try expect(!itemExists(root.appendingPathComponent("injected")), "shell substitution executed")
        }
        try check("successful replacement retains a complete previous app until cleanup") {
            let tx = try transaction("success")
            _ = try execute(tx.prepareScript)
            try expect(try execute(tx.replaceScript) == 0, "replacement failed")
            try expect(try marker(tx.destination) == "new", "new app not installed")
            try expect(try marker(tx.previous) == "old", "old backup missing")
        }
        try check("real codesign rejection preserves the existing bundle") {
            let tx = try transaction("bad-signature")
            try "tamper".write(to: tx.source.appendingPathComponent("Contents/Resources/marker.txt"), atomically: true, encoding: .utf8)
            try expect(try execute(tx.prepareScript) != 0, "tampered signature was accepted")
            try expect(try marker(tx.destination) == "old", "signature failure changed old app")
        }
        try check("failed publication restores the renamed old app") {
            let tx = try transaction("failed-publication")
            _ = try execute(tx.prepareScript)
            let command = "/bin/mv \(shellQuote(tx.staged.path)) \(shellQuote(tx.destination.path))"
            try expect(try execute(tx.replaceScript.replacingOccurrences(of: command, with: "/usr/bin/false")) != 0, "failure injection failed")
            try expect(try marker(tx.destination) == "old", "publication failure lost old app")
            try expect(!itemExists(tx.previous), "backup was not restored")
        }
        try check("post-publication verification failure rolls back both bundle moves") {
            let tx = try transaction("failed-final-verification")
            _ = try execute(tx.prepareScript)
            let lines = tx.replaceScript.components(separatedBy: "\n")
            var changed = lines
            changed[changed.count - 1] = "/usr/bin/false"
            try expect(try execute(changed.joined(separator: "\n")) != 0, "final failure injection failed")
            try expect(try marker(tx.destination) == "old", "post-publication failure lost old app")
            try expect(try marker(tx.staged) == "new", "new candidate was not retained")
        }
        try check("symbolic-link destination is rejected without changing its target") {
            let tx = try transaction("symlink")
            _ = try execute(tx.prepareScript)
            let victim = tx.destination.deletingLastPathComponent().appendingPathComponent("victim.app")
            try fm.moveItem(at: tx.destination, to: victim)
            try fm.createSymbolicLink(at: tx.destination, withDestinationURL: victim)
            try expect(try execute(tx.replaceScript) != 0, "symlink destination was accepted")
            try expect(try marker(victim) == "old", "symlink target changed")
        }
        try check("process snapshots keep commands containing spaces intact") {
            let rows = try parseProcessSnapshot(" 123 1 501 /Applications/安装 App.app/Contents/MacOS/App --flag\n")
            try expect(rows.count == 1 && rows[0].command.contains("安装 App.app"), "command was truncated")
        }
        try check("empty and malformed process snapshots fail closed") {
            for text in ["", "not a process row", "0 1 501 command", "2 -1 501 command"] {
                do { _ = try parseProcessSnapshot(text); throw CheckFailure.assertion("bad snapshot accepted") }
                catch InstallerFailure.commandFailed { }
            }
        }
        try check("managed descendants and detached branded processes are included") {
            let rows = try parseProcessSnapshot("10 1 501 /Applications/Fixture.app/Contents/MacOS/Fixture\n11 10 501 helper\n12 11 501 child\n13 1 501 /Users/fixture/.cutej/.desktop/bin/node\n14 1 501 /Applications/Fixture.app-copy/unrelated\n")
            let owned = managedProcesses(rows, roots: [URL(fileURLWithPath: "/Applications/Fixture.app"), URL(fileURLWithPath: "/Users/fixture/.cutej/.desktop")], applicationPids: [], installerPid: 99)
            try expect(Set(owned.map(\.pid)) == [10, 11, 12, 13], "managed tree boundary incorrect")
        }
        try check("installer and its descendants remain excluded under an owned root") {
            let rows = try parseProcessSnapshot("10 1 501 /Applications/Fixture.app/Contents/MacOS/Fixture\n99 1 501 /Applications/Fixture.app/install\n100 99 501 helper\n101 100 501 child\n")
            let owned = managedProcesses(rows, roots: [URL(fileURLWithPath: "/Applications/Fixture.app")], applicationPids: [], installerPid: 99)
            try expect(owned.map(\.pid) == [10], "installer's own tree was included")
        }
        try check("ad-hoc and development signatures cannot satisfy release metadata") {
            for text in ["Identifier=x\nTeamIdentifier=TEST\nSignature=adhoc\nCDHash=abc\n", "Identifier=x\nTeamIdentifier=TEST\nAuthority=Apple Development: Fixture\nCDHash=abc\n"] {
                do { _ = try AppSignature(details: text); throw CheckFailure.assertion("non-release accepted") }
                catch InstallerFailure.invalidSignature { }
            }
        }
        try check("brand configuration rejects path traversal") {
            do { _ = try configuration("../Other"); throw CheckFailure.assertion("path traversal accepted") }
            catch InstallerFailure.invalidPackage { }
        }
        try check("full installer copies before shutdown and publishes before launch") {
            var opened = false
            let (installer, commands, destination) = try fullFixture("full-success", open: { url in
                try expect(try marker(url) == "new", "opened before publish"); opened = true
            })
            try installer.install()
            try expect(opened && commands.events == ["copy", "shutdown", "replace"], "incorrect lifecycle order")
            try expect(try marker(destination) == "new", "replacement missing")
        }
        try check("FAILED acknowledgement prevents replacement") {
            let (installer, commands, destination) = try fullFixture("failed-ack", configure: { $0.ackStatus = "FAILED"; $0.ackOK = false })
            do { try installer.install(); throw CheckFailure.assertion("FAILED ack accepted") }
            catch InstallerFailure.shutdownFailed { }
            try expect(commands.shutdownCalled && !commands.events.contains("replace"), "replacement ran after FAILED ack")
            try expect(try marker(destination) == "old", "FAILED ack changed old app")
        }
        try check("acknowledgement must report installer mode and successful cleanup") {
            let (installer, _, destination) = try fullFixture("wrong-ack-mode", configure: { $0.ackMode = "user" })
            do { try installer.install(); throw CheckFailure.assertion("wrong mode accepted") }
            catch InstallerFailure.shutdownFailed { }
            try expect(try marker(destination) == "old", "wrong ACK changed old app")
        }
        try check("staging failure never requests application shutdown") {
            let (installer, commands, destination) = try fullFixture("copy-failure", configure: { $0.failStageSignature = true })
            do { try installer.install(); throw CheckFailure.assertion("staging failure accepted") }
            catch InstallerFailure.commandFailed { }
            try expect(!commands.shutdownCalled && (try marker(destination)) == "old", "old app changed before candidate ready")
        }
        try check("snapshot failure stops before shutdown and publication") {
            let (installer, commands, destination) = try fullFixture("snapshot-failure", configure: { $0.snapshotText = "" })
            do { try installer.install(); throw CheckFailure.assertion("empty snapshot accepted") }
            catch InstallerFailure.commandFailed { }
            try expect(!commands.shutdownCalled && (try marker(destination)) == "old", "snapshot failure stopped app")
        }
        try check("another user's app prevents shutdown") {
            let (installer, commands, _) = try fullFixture("foreign-user")
            let pid = Int32.max - 4
            commands.snapshotText = "\(pid) 1 \(getuid() + 1) /arbitrary/process\n"
            // Add a branded path to make this a detached managed process.
            commands.snapshotText = "\(pid) 1 \(getuid() + 1) \(installer.home.path)/.cutej-installer-fixture/.desktop/bin/node\n"
            do { try installer.install(); throw CheckFailure.assertion("foreign app accepted") }
            catch InstallerFailure.anotherUser { }
            try expect(!commands.shutdownCalled, "foreign user process was asked to exit")
        }
        try check("different publisher cannot be installed") {
            let (installer, commands, _) = try fullFixture("wrong-team", configure: { $0.wrongTeam = true })
            do { try installer.install(); throw CheckFailure.assertion("publisher mismatch accepted") }
            catch InstallerFailure.invalidSignature { }
            try expect(!commands.shutdownCalled && !commands.events.contains("copy"), "publisher failure reached staging")
        }
        try check("launch failure preserves the old bundle backup") {
            let (installer, _, destination) = try fullFixture("launch-failure", open: { _ in throw InstallerFailure.commandFailed })
            do { try installer.install(); throw CheckFailure.assertion("launch failure accepted") }
            catch InstallerFailure.recoveryRequired(let path) {
                try expect(try marker(URL(fileURLWithPath: path).appendingPathComponent("Previous.app")) == "old", "launch failure lost backup")
            }
            try expect(try marker(destination) == "new", "verified replacement unexpectedly removed")
        }
        try check("an actual old process must exit before the new app opens") {
            var applications: [RunningInstallerApp] = []
            var oldPid: Int32 = 0
            let (installer, commands, destination) = try fullFixture("real-process", running: { applications }, open: { _ in
                try expect(kill(oldPid, 0) != 0, "new app opened while old process was alive")
            })
            // Reparent a disposable sleep to launchd so it is not excluded as an
            // installer child. Its PID is explicitly selected as the old app.
            let started = try run("/bin/bash", ["-c", "/usr/bin/nohup /bin/sleep 20 >/dev/null 2>&1 & printf '%s' \"$!\""])
            guard let pid = Int32(String(decoding: started.output, as: UTF8.self)) else { throw CheckFailure.assertion("fixture process did not start") }
            oldPid = pid
            defer { if kill(pid, 0) == 0 { kill(pid, SIGKILL) } }
            Thread.sleep(forTimeInterval: 0.03)
            applications = [RunningInstallerApp(pid: pid, url: destination)]
            commands.stoppedPid = pid
            try expect(kill(pid, 0) == 0, "old process was not alive before install")
            try installer.install()
            try expect(kill(pid, 0) != 0, "independent PID verification did not observe exit")
            try expect(try marker(destination) == "new", "new app missing after old process exited")
        }
        try check("first installation accepts NO_PRIMARY and does not require an old bundle") {
            let (installer, commands, destination) = try fullFixture("first-install", configure: { $0.ackStatus = "NO_PRIMARY" })
            try fm.removeItem(at: destination)
            try installer.install()
            try expect(try marker(destination) == "new", "first install did not publish")
            try expect(commands.shutdownCalled, "first install skipped the primary-instance check")
        }
        try check("a concurrent install lock rejects another publisher before staging") {
            let (installer, commands, destination) = try fullFixture("concurrent-lock")
            let lockURL = fm.temporaryDirectory.appendingPathComponent(installer.configuration.storageNamespace + "-install.lock")
            let fd = Darwin.open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw CheckFailure.assertion("could not create lock fixture") }
            defer { flock(fd, LOCK_UN); Darwin.close(fd) }
            try expect(flock(fd, LOCK_EX | LOCK_NB) == 0, "could not hold fixture lock")
            do { try installer.install(); throw CheckFailure.assertion("concurrent installer accepted") }
            catch InstallerFailure.alreadyInstalling { }
            try expect(commands.events.isEmpty && !commands.shutdownCalled, "lock failure reached staging")
            try expect(try marker(destination) == "old", "concurrent installer changed old app")
        }
        try check("cancelled initial authorization preserves the old app and releases the install lock") {
            let (installer, commands, destination) = try fullFixture("authorization-cancel")
            try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: destination.path)
            defer { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path) }
            do { try installer.install(); throw CheckFailure.assertion("cancelled authorization accepted") }
            catch InstallerFailure.authorizationCancelled { }
            try expect(commands.authorizationCalls == 1 && !commands.shutdownCalled, "cancellation prompted twice or stopped app")
            try expect(try marker(destination) == "old", "cancellation replaced old app")
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
            try installer.install()
            try expect(try marker(destination) == "new", "cancelled install retained an unreleased lock")
        }
        try check("cancelled replacement authorization cleans staging without a second cleanup prompt") {
            let (installer, commands, destination) = try fullFixture("replacement-authorization-cancel", configure: { $0.cancelAuthorizationAt = 2 })
            try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: destination.path)
            defer { try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path) }
            do { try installer.install(); throw CheckFailure.assertion("cancelled replacement accepted") }
            catch InstallerFailure.authorizationCancelled { }
            try expect(commands.authorizationCalls == 2, "cleanup caused an extra authorization prompt")
            try expect(commands.shutdownCalled && (try marker(destination)) == "old", "replacement cancellation changed old app")
            let leftovers = try fm.contentsOfDirectory(atPath: installer.destinationDirectory.path)
                .filter { $0.hasPrefix("." + installer.configuration.storageNamespace + "-install-") }
            try expect(leftovers.isEmpty, "cancelled candidate was not cleaned")
        }
        try check("a real intact user-owned ad-hoc app can be replaced using its captured code hash") {
            let tx = try transaction("adhoc-old-accepted")
            let policy = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                identifier: identifier, team: "TESTTEAM", commands: system)
            guard case .localAdHoc(let id, let owner, let hashes) = policy else { throw CheckFailure.assertion("ad-hoc policy missing") }
            try expect(id == identifier && owner == getuid() && !hashes.isEmpty && hashes.allSatisfy { $0.count == 40 }, "ad-hoc identity capture incomplete")
            let local = InstallFileTransaction(source: tx.source, destination: tx.destination, workspace: tx.workspace,
                requirement: tx.requirement, existingPolicy: policy)
            try expect(try execute(local.prepareScript) == 0, "ad-hoc transaction stage failed")
            try expect(try execute(local.replaceScript) == 0, "ad-hoc old app was not replaced")
            try expect(try marker(local.destination) == "new", "ad-hoc replacement did not publish")
            try expect(try marker(local.previous) == "old", "ad-hoc old app backup missing")
        }
        try check("tampered ad-hoc old applications remain rejected") {
            let tx = try transaction("adhoc-tampered")
            try "tampered".write(to: tx.destination.appendingPathComponent("Contents/Resources/marker.txt"), atomically: true, encoding: .utf8)
            do {
                _ = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                    identifier: identifier, team: "TESTTEAM", commands: system)
                throw CheckFailure.assertion("tampered ad-hoc app accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("ad-hoc exception requires the Info.plist brand identifier") {
            let tx = try transaction("adhoc-info-id")
            let infoURL = tx.destination.appendingPathComponent("Contents/Info.plist")
            var info = try readAppInfo(tx.destination)
            info["CFBundleIdentifier"] = "cc.other.product"
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: infoURL)
            _ = try checkedCommand(system, "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, tx.destination.path])
            do {
                _ = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                    identifier: identifier, team: "TESTTEAM", commands: system)
                throw CheckFailure.assertion("wrong Info identifier accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("ad-hoc exception also requires the codesign brand identifier") {
            let tx = try transaction("adhoc-code-id")
            _ = try checkedCommand(system, "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "cc.other.product", tx.destination.path])
            do {
                _ = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                    identifier: identifier, team: "TESTTEAM", commands: system)
                throw CheckFailure.assertion("wrong signing identifier accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("ad-hoc exception requires the installing user's ownership") {
            let tx = try transaction("adhoc-owner")
            do {
                _ = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                    identifier: identifier, team: "TESTTEAM", owner: getuid() + 1, commands: system)
                throw CheckFailure.assertion("another owner's local app accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("ad-hoc applications at another path cannot use the exception") {
            let tx = try transaction("adhoc-other-path")
            do {
                _ = try existingAppReplacementPolicy(tx.source, destination: tx.destination,
                    identifier: identifier, team: "TESTTEAM", commands: system)
                throw CheckFailure.assertion("another ad-hoc path accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("incoming ad-hoc applications still fail the official release gate") {
            let tx = try transaction("adhoc-source-denied")
            do {
                _ = try releaseSignature(tx.source, identifier: identifier, commands: system)
                throw CheckFailure.assertion("incoming ad-hoc app accepted")
            } catch InstallerFailure.invalidSignature { }
        }
        try check("a newly re-signed old app cannot evade its captured ad-hoc code hash") {
            let tx = try transaction("adhoc-old-changed")
            let policy = try existingAppReplacementPolicy(tx.destination, destination: tx.destination,
                identifier: identifier, team: "TESTTEAM", commands: system)
            let local = InstallFileTransaction(source: tx.source, destination: tx.destination, workspace: tx.workspace,
                requirement: tx.requirement, existingPolicy: policy)
            _ = try execute(local.prepareScript)
            // A changed executable gives the old app a different CodeDirectory hash,
            // even though the replacement remains a valid ad-hoc signed bundle.
            let executable = tx.destination.appendingPathComponent("Contents/MacOS/Fixture")
            try fm.removeItem(at: executable)
            try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/false"), to: executable)
            _ = try checkedCommand(system, "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, tx.destination.path])
            try expect(try execute(local.replaceScript) != 0, "changed code hash passed publication")
            try expect(try marker(local.destination) == "old", "changed old app was moved")
            try expect(!itemExists(local.previous), "old app moved before hash verification")
        }
        try check("complete install accepts a real ad-hoc old target without executing it") {
            var applications: [RunningInstallerApp] = []
            let (installer, commands, destination) = try fullFixture("full-adhoc-old", running: { applications })
            commands.realSignaturePaths.insert(destination.path)
            // NSWorkspace returns directory URLs; a trailing slash must not make
            // this exact destination look like a different application path.
            applications = [RunningInstallerApp(pid: Int32.max - 3, url: URL(fileURLWithPath: destination.path, isDirectory: true))]
            try installer.install()
            try expect(try marker(destination) == "new", "ad-hoc old target did not update")
            try expect(commands.events == ["copy", "shutdown", "replace"], "ad-hoc compatibility changed lifecycle")
        }
        try check("foreign formal publishers cannot fall back to local ad-hoc compatibility") {
            let (installer, commands, destination) = try fullFixture("foreign-formal-old")
            commands.foreignPublisherPaths.insert(destination.path)
            do { try installer.install(); throw CheckFailure.assertion("foreign formal publisher accepted") }
            catch InstallerFailure.invalidSignature { }
            try expect(!commands.shutdownCalled && commands.events.isEmpty, "foreign publisher reached staging")
            try expect(try marker(destination) == "old", "foreign formal app changed")
        }
        try check("the installer droplet accepts exactly its independently located source bundle") {
            let tx = try transaction("drop-source")
            try validateInstallerDrop([tx.source.path], source: tx.source)
            try validateInstallerDrop([tx.source.path + "/"], source: tx.source)
        }
        try check("the installer droplet rejects a different same-name application") {
            let tx = try transaction("drop-other-source")
            let other = tx.destination.deletingLastPathComponent().appendingPathComponent("other-volume")
                .appendingPathComponent(tx.source.lastPathComponent)
            try makeApp(other, marker: "other")
            do {
                try validateInstallerDrop([other.path], source: tx.source)
                throw CheckFailure.assertion("same-name application from another path accepted")
            } catch InstallerFailure.invalidPackage { }
        }
        try check("the installer droplet rejects multiple or absent dropped files") {
            let tx = try transaction("drop-multiple")
            for paths in [[tx.source.path, tx.destination.path], [], ["relative.app"]] {
                do {
                    try validateInstallerDrop(paths, source: tx.source)
                    throw CheckFailure.assertion("non-single-source drop accepted")
                } catch InstallerFailure.invalidPackage { }
            }
        }
        print("PASSED \(checks) installer checks")
    }
}
