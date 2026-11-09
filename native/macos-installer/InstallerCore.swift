import Foundation
import Darwin

enum InstallerFailure: Error {
    case invalidPackage, invalidSignature, unsafeDestination, commandFailed, authorizationCancelled
    case shutdownFailed, shutdownTimeout, processesRunning, anotherUser, alreadyInstalling, recoveryRequired(String)
}

enum InstallStage: String { case preparing, stopping, replacing, opening }

func validateInstallerDrop(_ paths: [String], source: URL) throws {
    // Dropping selects the action, never the incoming code. The caller locates
    // and verifies the payload independently; only that exact bundle is allowed.
    guard paths.count == 1, let path = paths.first, path.hasPrefix("/") else {
        throw InstallerFailure.invalidPackage
    }
    let dropped = URL(fileURLWithPath: path)
    guard dropped.standardizedFileURL.path == source.standardizedFileURL.path,
          dropped.resolvingSymlinksInPath().path == source.resolvingSymlinksInPath().path else {
        throw InstallerFailure.invalidPackage
    }
}

struct InstallerConfiguration {
    let productName: String
    let bundleIdentifier: String
    let storageNamespace: String
    let shutdownArgument: String
    let runtimeRootDirName: String
    let desktopDataSubdirectory: String
    let programDataDirName: String
    let version: String

    init(info: [String: Any]) throws {
        func value(_ key: String, component: Bool = false) throws -> String {
            guard let text = info[key] as? String, !text.isEmpty, !text.contains("\0"),
                  !text.contains("\n"), !text.contains("\r"),
                  !component || (text != "." && text != ".." && !text.contains("/")) else {
                throw InstallerFailure.invalidPackage
            }
            return text
        }
        productName = try value("DesktopProductName", component: true)
        bundleIdentifier = try value("DesktopBundleIdentifier")
        storageNamespace = try value("DesktopStorageNamespace", component: true)
        shutdownArgument = try value("DesktopShutdownArgument")
        runtimeRootDirName = try value("DesktopRuntimeRootDirName", component: true)
        desktopDataSubdirectory = try value("DesktopDataSubdirectory", component: true)
        programDataDirName = try value("DesktopProgramDataDirName", component: true)
        version = try value("CFBundleShortVersionString")
        guard bundleIdentifier.range(of: "^[A-Za-z0-9.-]+$", options: .regularExpression) != nil,
              storageNamespace.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
              shutdownArgument.hasPrefix("--") else { throw InstallerFailure.invalidPackage }
    }
}

struct CommandResult { let status: Int32; let output: Data }

protocol InstallerCommands {
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult
}

struct SystemInstallerCommands: InstallerCommands {
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 60) throws -> CommandResult {
        // A file avoids pipe backpressure while codesign/ditto or a shutdown helper runs.
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: outputURL.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600]) else {
            throw InstallerFailure.commandFailed
        }
        defer { try? FileManager.default.removeItem(at: outputURL) }
        let output = try FileHandle(forWritingTo: outputURL)
        defer { try? output.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        // Electron must run as an application with the user's ordinary brand profile.
        for key in ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"] { environment.removeValue(forKey: key) }
        process.environment = environment
        process.standardOutput = output
        process.standardError = output
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            // Only our command child is stopped; never signal a running Desktop this way.
            process.terminate()
            if finished.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = finished.wait(timeout: .now() + 2)
            }
            throw InstallerFailure.commandFailed
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        guard (attributes[.size] as? NSNumber)?.intValue ?? 0 <= 8 * 1024 * 1024 else {
            throw InstallerFailure.commandFailed
        }
        return CommandResult(status: process.terminationStatus, output: try Data(contentsOf: outputURL))
    }
}

func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

func checkedCommand(_ commands: InstallerCommands, _ executable: String, _ arguments: [String],
                    timeout: TimeInterval = 60) throws -> Data {
    let result = try commands.run(executable, arguments, timeout: timeout)
    guard result.status == 0 else { throw InstallerFailure.commandFailed }
    return result.output
}

struct AppSignature {
    let identifier: String
    let team: String
    let codeHash: String

    init(details: String) throws {
        func field(_ prefix: String) -> String {
            details.components(separatedBy: .newlines).first(where: { $0.hasPrefix(prefix + "=") })?
                .dropFirst(prefix.count + 1).description ?? ""
        }
        identifier = field("Identifier")
        team = field("TeamIdentifier")
        codeHash = field("CDHash")
        guard details.components(separatedBy: .newlines).contains(where: { $0.hasPrefix("Authority=Developer ID Application:") }),
              team.range(of: "^[A-Z0-9]+$", options: .regularExpression) != nil,
              !identifier.isEmpty, !codeHash.isEmpty else { throw InstallerFailure.invalidSignature }
    }

    var requirement: String {
        "identifier \"\(identifier)\" and anchor apple generic and " +
        "certificate 1[field.1.2.840.113635.100.6.2.6] and " +
        "certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"\(team)\""
    }
}

func readAppInfo(_ appURL: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: appURL.appendingPathComponent("Contents/Info.plist"))
    guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw InstallerFailure.invalidPackage
    }
    return info
}

func releaseSignature(_ appURL: URL, identifier: String, team: String? = nil,
                      commands: InstallerCommands) throws -> AppSignature {
    do {
        let details = try checkedCommand(commands, "/usr/bin/codesign", ["--display", "--verbose=4", appURL.path])
        let signature = try AppSignature(details: String(decoding: details, as: UTF8.self))
        guard signature.identifier == identifier, team == nil || team == signature.team else {
            throw InstallerFailure.invalidSignature
        }
        _ = try checkedCommand(commands, "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", "-R", "=" + signature.requirement, appURL.path], timeout: 120)
        return signature
    } catch {
        throw InstallerFailure.invalidSignature
    }
}

enum ExistingAppReplacementPolicy: Equatable {
    case release(requirement: String)
    // This identity authorizes replacing one user-owned local app. It never
    // authorizes incoming code, another path, or an executable to launch.
    case localAdHoc(identifier: String, owner: UInt32, codeHashes: [String])

    var requirement: String {
        switch self {
        case .release(let requirement): return requirement
        case .localAdHoc(let identifier, _, let codeHashes):
            let hashes = codeHashes.map { "cdhash H\"\($0)\"" }.joined(separator: " or ")
            return "identifier \"\(identifier)\" and (\(hashes))"
        }
    }

    func verificationScript(for appURL: URL) -> String {
        let verify = "/usr/bin/codesign --verify --deep --strict -R \(shellQuote("=" + requirement)) \(shellQuote(appURL.path))"
        switch self {
        case .release: return verify
        case .localAdHoc(let identifier, let owner, _):
            return """
            test "$(/usr/bin/stat -f %u \(shellQuote(appURL.path)))" = \(shellQuote(String(owner)))
            test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \(shellQuote(appURL.appendingPathComponent("Contents/Info.plist").path)))" = \(shellQuote(identifier))
            old_signature=$(/usr/bin/codesign --display --verbose=4 \(shellQuote(appURL.path)) 2>&1)
            printf '%s\\n' "$old_signature" | /usr/bin/grep -qx 'Signature=adhoc'
            if printf '%s\\n' "$old_signature" | /usr/bin/grep -q '^Authority='; then exit 73; fi
            old_team=$(printf '%s\\n' "$old_signature" | /usr/bin/sed -n 's/^TeamIdentifier=//p')
            if [ -n "$old_team" ] && [ "$old_team" != 'not set' ]; then exit 74; fi
            \(verify)
            """
        }
    }
}

func existingAppReplacementPolicy(_ appURL: URL, destination: URL, identifier: String, team: String,
                                  owner: UInt32 = getuid(), commands: InstallerCommands) throws -> ExistingAppReplacementPolicy {
    do {
        guard !(try isSymbolicLink(appURL)),
              try readAppInfo(appURL)["CFBundleIdentifier"] as? String == identifier else {
            throw InstallerFailure.invalidSignature
        }
        if let signature = try? releaseSignature(appURL, identifier: identifier, team: team, commands: commands) {
            return .release(requirement: signature.requirement)
        }
        // Only a complete local development build at this exact install target
        // may be replaced without an Apple publisher. Formal foreign publishers
        // cannot fall back, and source/stage validation never calls this function.
        guard appURL.standardizedFileURL.path == destination.standardizedFileURL.path,
              appURL.resolvingSymlinksInPath().path == destination.resolvingSymlinksInPath().path,
              !(try isSymbolicLink(destination.deletingLastPathComponent())),
              (try FileManager.default.attributesOfItem(atPath: appURL.path)[.ownerAccountID] as? NSNumber)?.uint32Value == owner else {
            throw InstallerFailure.invalidSignature
        }
        func adHocHash(_ data: Data) throws -> String {
            let lines = String(decoding: data, as: UTF8.self).components(separatedBy: .newlines)
            func field(_ name: String) -> String {
                lines.first(where: { $0.hasPrefix(name + "=") })?.dropFirst(name.count + 1).description ?? ""
            }
            let codeHash = field("CDHash")
            guard field("Identifier") == identifier, field("Signature") == "adhoc",
                  !lines.contains(where: { $0.hasPrefix("Authority=") }),
                  ["", "not set"].contains(field("TeamIdentifier")),
                  codeHash.range(of: "^[a-fA-F0-9]{40}$", options: .regularExpression) != nil else {
                throw InstallerFailure.invalidSignature
            }
            return codeHash
        }
        let data = try checkedCommand(commands, "/usr/bin/codesign", ["--display", "--verbose=4", appURL.path])
        var hashes: Set<String> = [try adHocHash(data)]
        // Display selects one slice, whereas verification checks every slice.
        // Capture both supported Desktop architectures without requiring lipo or
        // developer tools on the user's Mac. Unexpected slices still fail closed.
        for architecture in ["arm64", "x86_64"] {
            let result = try commands.run("/usr/bin/codesign",
                ["--display", "--verbose=4", "--architecture", architecture, appURL.path], timeout: 60)
            if result.status == 0 { hashes.insert(try adHocHash(result.output)) }
        }
        let policy = ExistingAppReplacementPolicy.localAdHoc(identifier: identifier, owner: owner, codeHashes: hashes.sorted())
        _ = try checkedCommand(commands, "/usr/bin/codesign",
            ["--verify", "--deep", "--strict", "-R", "=" + policy.requirement, appURL.path], timeout: 120)
        return policy
    } catch { throw InstallerFailure.invalidSignature }
}

func isSymbolicLink(_ url: URL) throws -> Bool {
    // attributesOfItem uses lstat, including for an otherwise dangling symlink.
    (try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType) == .typeSymbolicLink
}

func itemExists(_ url: URL) -> Bool {
    (try? FileManager.default.attributesOfItem(atPath: url.path)) != nil
}

struct RunningInstallerApp { let pid: Int32; let url: URL }
struct InstallerProcess { let pid: Int32; let parent: Int32; let uid: UInt32; let command: String }

func parseProcessSnapshot(_ text: String) throws -> [InstallerProcess] {
    let rows = try text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { line in
        let parts = line.split(maxSplits: 3, omittingEmptySubsequences: true, whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 4, let pid = Int32(parts[0]), pid > 0, let parent = Int32(parts[1]), parent >= 0,
              let uid = UInt32(parts[2]) else { throw InstallerFailure.commandFailed }
        return InstallerProcess(pid: pid, parent: parent, uid: uid, command: String(parts[3]))
    }
    guard !rows.isEmpty else { throw InstallerFailure.commandFailed }
    return rows
}

func managedProcesses(_ rows: [InstallerProcess], roots: [URL], applicationPids: Set<Int32>,
                      installerPid: Int32) -> [InstallerProcess] {
    func descendants(_ initial: Set<Int32>) -> Set<Int32> {
        var result = initial
        while true {
            let children = Set(rows.filter { result.contains($0.parent) }.map(\.pid))
            let next = result.union(children)
            if next == result { return result }
            result = next
        }
    }
    let excluded = descendants([installerPid])
    let direct = Set(rows.filter { row in
        applicationPids.contains(row.pid) || roots.contains { row.command.contains($0.path + "/") }
    }.map(\.pid))
    let owned = descendants(direct).subtracting(excluded)
    return rows.filter { owned.contains($0.pid) }
}

struct InstallFileTransaction {
    let source: URL
    let destination: URL
    let workspace: URL
    let requirement: String
    let existingPolicy: ExistingAppReplacementPolicy?
    init(source: URL, destination: URL, workspace: URL, requirement: String,
         existingPolicy: ExistingAppReplacementPolicy? = nil) {
        self.source = source; self.destination = destination; self.workspace = workspace
        self.requirement = requirement; self.existingPolicy = existingPolicy
    }
    var staged: URL { workspace.appendingPathComponent("New.app") }
    var previous: URL { workspace.appendingPathComponent("Previous.app") }

    private func verify(_ url: URL) -> String {
        "/usr/bin/codesign --verify --deep --strict -R \(shellQuote("=" + requirement)) \(shellQuote(url.path))"
    }

    var prepareScript: String {
        """
        set -euo pipefail
        /bin/mkdir -m 755 \(shellQuote(workspace.path))
        /usr/bin/ditto --rsrc --extattr \(shellQuote(source.path)) \(shellQuote(staged.path))
        \(verify(staged))
        """
    }

    var replaceScript: String {
        // The backup survives until a verified replacement has been opened. A failed
        // rename or final signature check restores it; no in-place bundle copy occurs.
        """
        set -euo pipefail
        published=0
        backed_up=0
        restore() {
          status=$?
          if [ "$status" -ne 0 ]; then
            if [ "$published" -eq 1 ]; then
              /bin/mv \(shellQuote(destination.path)) \(shellQuote(staged.path)) || exit 71
            fi
            if [ "$backed_up" -eq 1 ]; then
              /bin/mv \(shellQuote(previous.path)) \(shellQuote(destination.path)) || exit 72
            fi
          fi
          exit "$status"
        }
        trap restore EXIT
        test -d \(shellQuote(destination.deletingLastPathComponent().path))
        test ! -L \(shellQuote(destination.deletingLastPathComponent().path))
        test -d \(shellQuote(workspace.path)) && test ! -L \(shellQuote(workspace.path))
        test -d \(shellQuote(staged.path)) && test ! -L \(shellQuote(staged.path))
        \(verify(staged))
        if [ -e \(shellQuote(destination.path)) ] || [ -L \(shellQuote(destination.path)) ]; then
          test -d \(shellQuote(destination.path)) && test ! -L \(shellQuote(destination.path))
          \(existingPolicy?.verificationScript(for: destination) ?? verify(destination))
          /bin/mv \(shellQuote(destination.path)) \(shellQuote(previous.path))
          backed_up=1
        fi
        /bin/mv \(shellQuote(staged.path)) \(shellQuote(destination.path))
        published=1
        \(verify(destination))
        """
    }
}

final class MacDmgInstaller {
    let configuration: InstallerConfiguration
    let installerURL: URL
    let destinationDirectory: URL
    let home: URL
    let commands: InstallerCommands
    let runningApplications: () -> [RunningInstallerApp]
    let progress: (InstallStage) -> Void
    let openApplication: (URL) throws -> Void

    init(configuration: InstallerConfiguration, installerURL: URL,
         destinationDirectory: URL = URL(fileURLWithPath: "/Applications"),
         home: URL = FileManager.default.homeDirectoryForCurrentUser,
         commands: InstallerCommands = SystemInstallerCommands(),
         runningApplications: @escaping () -> [RunningInstallerApp],
         progress: @escaping (InstallStage) -> Void,
         openApplication: @escaping (URL) throws -> Void) {
        self.configuration = configuration; self.installerURL = installerURL
        self.destinationDirectory = destinationDirectory; self.home = home; self.commands = commands
        self.runningApplications = runningApplications; self.progress = progress; self.openApplication = openApplication
    }

    func locateSource() throws -> URL {
        let direct = installerURL.deletingLastPathComponent().appendingPathComponent(configuration.productName + ".app")
        if itemExists(direct) { return direct }
        // Gatekeeper may translocate only this helper. Find its exact signed copy
        // on a mounted disk image, rather than scanning Downloads or installed apps.
        let own = try releaseSignature(installerURL, identifier: configuration.bundleIdentifier + ".installer", commands: commands)
        let data = try checkedCommand(commands, "/usr/bin/hdiutil", ["info", "-plist"])
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let images = info["images"] as? [[String: Any]] else { throw InstallerFailure.invalidPackage }
        for image in images {
            for entity in image["system-entities"] as? [[String: Any]] ?? [] {
                guard let mount = entity["mount-point"] as? String else { continue }
                let candidate = URL(fileURLWithPath: mount).appendingPathComponent(installerURL.lastPathComponent)
                guard let signature = try? releaseSignature(candidate, identifier: own.identifier, team: own.team, commands: commands),
                      signature.codeHash == own.codeHash else { continue }
                let source = candidate.deletingLastPathComponent().appendingPathComponent(configuration.productName + ".app")
                if itemExists(source) { return source }
            }
        }
        throw InstallerFailure.invalidPackage
    }

    func install() throws {
        // Different mounted versions can have distinct Finder instances. Serialize
        // replacement for this brand and user without taking Desktop's own lock.
        let lockURL = FileManager.default.temporaryDirectory.appendingPathComponent(configuration.storageNamespace + "-install.lock")
        let lock = Darwin.open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw InstallerFailure.commandFailed }
        defer { Darwin.close(lock) }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw InstallerFailure.alreadyInstalling }
        defer { flock(lock, LOCK_UN) }
        progress(.preparing)
        let source = try locateSource()
        let signature = try releaseSignature(source, identifier: configuration.bundleIdentifier, commands: commands)
        _ = try releaseSignature(installerURL, identifier: configuration.bundleIdentifier + ".installer", team: signature.team, commands: commands)
        let sourceInfo = try readAppInfo(source)
        guard sourceInfo["CFBundleShortVersionString"] as? String == configuration.version,
              let executable = sourceInfo["CFBundleExecutable"] as? String, !executable.isEmpty,
              executable != ".", executable != "..", !executable.contains("/") else { throw InstallerFailure.invalidPackage }
        let destination = destinationDirectory.appendingPathComponent(configuration.productName + ".app")
        guard source.resolvingSymlinksInPath() != destination.resolvingSymlinksInPath(),
              !(try isSymbolicLink(source)), !(try isSymbolicLink(destinationDirectory)) else {
            throw InstallerFailure.unsafeDestination
        }
        let replacementPolicy: ExistingAppReplacementPolicy?
        if itemExists(destination) {
            guard !(try isSymbolicLink(destination)) else { throw InstallerFailure.unsafeDestination }
            replacementPolicy = try existingAppReplacementPolicy(destination, destination: destination,
                identifier: configuration.bundleIdentifier, team: signature.team, commands: commands)
        } else { replacementPolicy = nil }
        let transaction = InstallFileTransaction(source: source, destination: destination,
            workspace: destinationDirectory.appendingPathComponent(".\(configuration.storageNamespace)-install-\(UUID().uuidString)"),
            requirement: signature.requirement, existingPolicy: replacementPolicy)
        let destinationOwner = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.ownerAccountID] as? NSNumber)?.uint32Value
        let needsAuthorization = !FileManager.default.isWritableFile(atPath: destinationDirectory.path) ||
            (itemExists(destination) && (destinationOwner != getuid() || !FileManager.default.isWritableFile(atPath: destination.path)))
        var published = false
        do {
            try fileOperation(transaction.prepareScript, authorized: needsAuthorization)
            progress(.stopping)
            try stopDesktop(source: source, executable: executable, signature: signature,
                            destination: destination, replacementPolicy: replacementPolicy)
            progress(.replacing)
            try fileOperation(transaction.replaceScript, authorized: needsAuthorization)
            published = true
            progress(.opening)
            try openApplication(destination)
        } catch {
            // Never erase a backup after an incomplete rollback or launch failure.
            if itemExists(transaction.previous) { throw InstallerFailure.recoveryRequired(transaction.workspace.path) }
            if !published && itemExists(transaction.workspace) {
                // A cancelled authorization must not trigger another password dialog.
                let cancelled: Bool
                if case InstallerFailure.authorizationCancelled = error { cancelled = true } else { cancelled = false }
                try? fileOperation("/bin/rm -rf \(shellQuote(transaction.workspace.path))", authorized: needsAuthorization && !cancelled)
            }
            throw error
        }
        // Cleanup cannot turn a completed installation into a reported failure.
        try? fileOperation("/bin/rm -rf \(shellQuote(transaction.workspace.path))", authorized: needsAuthorization)
    }

    private func fileOperation(_ script: String, authorized: Bool) throws {
        if authorized {
            let appleScript = "on run argv\ntry\ndo shell script (item 1 of argv) with administrator privileges\non error message number errorNumber\nif errorNumber is -128 then return \"CANCELLED\"\nerror message number errorNumber\nend try\nend run"
            let output = try checkedCommand(commands, "/usr/bin/osascript", ["-e", appleScript, script], timeout: 15 * 60)
            if String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "CANCELLED" {
                throw InstallerFailure.authorizationCancelled
            }
        } else {
            _ = try checkedCommand(commands, "/bin/bash", ["-c", script], timeout: 15 * 60)
        }
    }

    private func stopDesktop(source: URL, executable: String, signature: AppSignature, destination: URL,
                             replacementPolicy: ExistingAppReplacementPolicy?) throws {
        let applications = runningApplications()
        for application in applications {
            if let expected = replacementPolicy, application.url.standardizedFileURL.path == destination.standardizedFileURL.path {
                let current = try existingAppReplacementPolicy(application.url, destination: destination,
                    identifier: configuration.bundleIdentifier, team: signature.team, commands: commands)
                guard current == expected else { throw InstallerFailure.invalidSignature }
            } else {
                _ = try releaseSignature(application.url, identifier: configuration.bundleIdentifier, team: signature.team, commands: commands)
            }
        }
        let roots = [destination,
            home.appendingPathComponent("Library/Application Support").appendingPathComponent(configuration.programDataDirName),
            home.appendingPathComponent(configuration.runtimeRootDirName).appendingPathComponent(configuration.desktopDataSubdirectory)
        ] + applications.map(\.url)
        let appPids = Set(applications.map(\.pid))
        func snapshot() throws -> [InstallerProcess] {
            let data = try checkedCommand(commands, "/bin/ps", ["-ww", "-axo", "pid=,ppid=,uid=,command="], timeout: 10)
            return managedProcesses(try parseProcessSnapshot(String(decoding: data, as: UTF8.self)), roots: roots,
                                    applicationPids: appPids, installerPid: getpid())
        }
        let captured = try snapshot()
        guard !captured.contains(where: { $0.uid != getuid() }) else { throw InstallerFailure.anotherUser }
        let ack = FileManager.default.temporaryDirectory.appendingPathComponent(
            "\(configuration.storageNamespace)-shutdown-\(UUID().uuidString).status")
        defer { try? FileManager.default.removeItem(at: ack) }
        _ = try checkedCommand(commands, source.appendingPathComponent("Contents/MacOS").appendingPathComponent(executable).path,
            [configuration.shutdownArgument, "--desktop-shutdown-ack=" + ack.path], timeout: 25)
        let deadline = Date().addingTimeInterval(25)
        while !itemExists(ack) {
            guard Date() < deadline else { throw InstallerFailure.shutdownTimeout }
            Thread.sleep(forTimeInterval: 0.1)
        }
        let data = try Data(contentsOf: ack)
        guard data.count < 128 * 1024, let contents = String(data: data, encoding: .utf8) else { throw InstallerFailure.shutdownFailed }
        let lines = contents.components(separatedBy: "\n")
        guard lines.count >= 2, ["OK", "NO_PRIMARY"].contains(lines[0]),
              let report = try JSONSerialization.jsonObject(with: Data(lines[1].utf8)) as? [String: Any],
              report["ok"] as? Bool == true, report["mode"] as? String == "installer" else { throw InstallerFailure.shutdownFailed }
        while true {
            let fresh = try snapshot()
            let capturedAlive = captured.contains { kill($0.pid, 0) == 0 || errno == EPERM }
            if fresh.isEmpty && !capturedAlive { return }
            guard Date() < deadline else { throw InstallerFailure.processesRunning }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }
}
