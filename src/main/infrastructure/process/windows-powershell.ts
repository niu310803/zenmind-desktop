import path from "node:path";

export function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
