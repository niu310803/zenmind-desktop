import { execFile } from "node:child_process";
import path from "node:path";
import type { App } from "electron";
import { getServiceState } from "../modules/services";

const EXTERNAL_SERVICES = ["identity-center", "agent-platform", "agent-container-hub"] as const;

function parseTasklistWorkingSetBytes(output: string, expectedPid: number) {
  // The image name, PID and memory usage are CSV fields even on localized Windows.
  for (const line of output.split(/\r?\n/u)) {
    const fields = [...line.matchAll(/(?:^|,)\s*"((?:[^"]|"")*)"\s*(?=,|$)/gu)].map((match) => match[1]);
    if (fields.length !== 5 || Number(fields[1]) !== expectedPid) continue;
    const usage = fields[4].trim();
    const digits = usage.match(/^([\d.,'\s]+)[^\d]+$/u)?.[1].replace(/\D/gu, "");
    const bytes = digits ? Number(digits) * 1024 : NaN;
    if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
  }
  return null;
}

function getWindowsWorkingSetBytes(pid: number): Promise<number | null> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const command = path.win32.join(systemRoot, "System32", "tasklist.exe");
  return new Promise((resolve) => {
    execFile(command, ["/NH", "/FO", "CSV", "/FI", `PID eq ${pid}`], {
      encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024
    }, (error, stdout) => resolve(error ? null : parseTasklistWorkingSetBytes(stdout, pid)));
  });
}

export async function sampleServiceMemory(app: App) {
  if (process.platform !== "win32") return [];
  return Promise.all(EXTERNAL_SERVICES.map(async (serviceId) => {
    const readState = () => getServiceState(app, serviceId, { mode: "bridge" }).catch(() => null);
    const state = await readState();
    const pid = state?.status === "running" ? state.healthMeta.pid : null;
    if (!pid || pid === process.pid) {
      return { serviceId, pid: null, workingSetBytes: null };
    }
    const bytes = await getWindowsWorkingSetBytes(pid);
    const current = await readState();
    const stable = current?.status === "running" && current.healthMeta.pid === pid;
    return { serviceId, pid, workingSetBytes: stable ? bytes : null };
  }));
}

export const __testInternals = { parseTasklistWorkingSetBytes };
