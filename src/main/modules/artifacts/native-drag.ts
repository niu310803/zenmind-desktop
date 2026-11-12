import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, IpcMainEvent } from "electron";
import type { AssistantChatInfo } from "../../../shared/contracts";
import { ARTIFACT_DRAG_PREPARE_CHANNEL, ARTIFACT_DRAG_START_CHANNEL, type ArtifactDragIdentity, type ArtifactDragPreparation } from "../../../shared/contracts/agent-webclient-bridge";
import type { DesktopArtifactIdentity } from "../../../shared/artifacts";
import { artifactRelativePath } from "./actions";

const TTL = 2 * 60_000;
const RETENTION = 60 * 60_000;
const LIMIT = 100 * 1024 * 1024;
type DragEvent = IpcMainInvokeEvent | IpcMainEvent;
type Lease = { token: string; senderId: number; identity: ArtifactDragIdentity; authority: string; current(): boolean; file: string; directory: string; expiresAt: number; started: boolean; sizeBytes: number };

/** Export only verified snapshots. Even a target choosing Move cannot move a Chat original. */
export function registerArtifactDragIpc(ipc: Pick<IpcMain, "handle" | "on" | "removeHandler" | "removeListener">, ports: {
  platform: NodeJS.Platform;
  tempRoot: string;
  // Fingerprint must change with the real frame, surface registration, route and owner.
  authorize(event: DragEvent, identity: ArtifactDragIdentity): string | null;
  captureSourceGeneration(chatId: string): () => boolean;
  getChatInfo(chatId: string): Promise<AssistantChatInfo | null>;
  read(identity: DesktopArtifactIdentity, signal: AbortSignal): Promise<Buffer>;
  start(event: DragEvent, file: string): void;
}) {
  const leases = new Map<string, Lease>();
  const pending = new Set<number>();
  let disposed = false;
  const controllers = new Set<AbortController>();
  async function remove(lease: Lease) {
    leases.delete(lease.token);
    await fs.rm(lease.directory, { recursive: true, force: true }).catch(() => undefined);
  }
  async function sweep() {
    for (const lease of leases.values()) {
      if (Date.now() > (lease.started ? lease.expiresAt + RETENTION : lease.expiresAt)) await remove(lease);
    }
    // Clean snapshots left by a previous process without touching active exports.
    for (const entry of await fs.readdir(ports.tempRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^export-[a-zA-Z0-9]+$/u.test(entry.name)) continue;
      const directory = path.join(ports.tempRoot, entry.name);
      if ([...leases.values()].some(lease => lease.directory === directory)) continue;
      const stat = await fs.stat(directory).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 24 * RETENTION) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const timer = setInterval(() => { void sweep(); }, 60_000);
  timer.unref();
  void sweep();
  function valid(input: unknown): input is ArtifactDragIdentity {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const data = input as Record<string, unknown>;
    return Object.keys(data).every(key => ["chatId", "artifactId", "runId"].includes(key)) &&
      [data.chatId, data.artifactId, ...(data.runId === undefined ? [] : [data.runId])].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\x00-\x1f\x7f/\\]/u.test(value));
  }
  ipc.handle(ARTIFACT_DRAG_PREPARE_CHANNEL, async (event, input: unknown): Promise<ArtifactDragPreparation> => {
    if (disposed || !["darwin", "win32"].includes(ports.platform) || !valid(input)) return { ok: false };
    const authority = ports.authorize(event, input);
    if (!authority || pending.has(event.sender.id)) return { ok: false };
    for (const lease of leases.values()) {
      if (!lease.started && lease.authority === authority && lease.senderId === event.sender.id &&
        JSON.stringify(lease.identity) === JSON.stringify(input) && lease.current() && Date.now() < lease.expiresAt && existsSync(lease.file)) {
        return { ok: true, token: lease.token, expiresAt: lease.expiresAt };
      }
    }
    // Bound prepared leases separately from files retained for an in-progress OS copy.
    if (leases.size >= 256) return { ok: false };
    pending.add(event.sender.id);
    const sourceCurrent = ports.captureSourceGeneration(input.chatId);
    const current = () => !disposed && sourceCurrent() && ports.authorize(event, input) === authority;
    const controller = new AbortController(); controllers.add(controller);
    let directory: string | undefined;
    try {
      const unused = [...leases.values()].filter(lease => !lease.started);
      // Discard expired/revoked preparation and the oldest unused preview, never an OS copy.
      for (const lease of unused) {
        if (!lease.current() || Date.now() >= lease.expiresAt || (unused.length >= 8 && lease === unused[0])) await remove(lease);
      }
      if (!current()) return { ok: false };
      const info = await ports.getChatInfo(input.chatId);
      if (!current() || info?.chatId !== input.chatId || !info.agentKey) return { ok: false };
      const detail = JSON.parse(info.rawJson);
      if (detail?.chatId !== input.chatId || !Array.isArray(detail.artifact?.items)) return { ok: false };
      const matches = detail.artifact.items.filter((item: Record<string, unknown>) => item?.artifactId === input.artifactId &&
        (!input.runId || artifactRelativePath(item.url, input.chatId)?.split("/")[1] === input.runId));
      if (matches.length !== 1) return { ok: false };
      const artifact = matches[0], relative = artifactRelativePath(artifact.url, input.chatId);
      const runId = relative?.split("/")[1];
      if (!relative || !runId || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || artifact.sizeBytes > LIMIT ||
        typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(artifact.sha256)) return { ok: false };
      const bytes = await ports.read({ chatId: input.chatId, artifactId: input.artifactId, runId }, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      if (!current() || bytes.length !== artifact.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256.toLowerCase()) return { ok: false };
      if ([...leases.values()].reduce((sum, lease) => sum + lease.sizeBytes, 0) + bytes.length > 512 * 1024 * 1024) return { ok: false };
      const name = path.posix.basename(relative);
      // Explicit Windows filename policy: reject aliases, alternate streams and reserved devices.
      if (ports.platform === "win32" && (/[<>:"/\\|?*]|[. ]$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))) return { ok: false };
      if (ports.platform === "darwin" && /[:\x00]/u.test(name)) return { ok: false };
      await fs.mkdir(ports.tempRoot, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(ports.tempRoot, "export-"));
      const file = path.join(directory, name);
      await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      if (!current()) return { ok: false };
      const lease: Lease = { token: randomUUID(), senderId: event.sender.id, identity: input, authority, current, file, directory, expiresAt: Date.now() + TTL, started: false, sizeBytes: bytes.length };
      leases.set(lease.token, lease); directory = undefined;
      return { ok: true, token: lease.token, expiresAt: lease.expiresAt };
    } catch { return { ok: false }; }
    finally {
      pending.delete(event.sender.id); controllers.delete(controller);
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  const start = (event: IpcMainEvent, token: unknown) => {
    if (disposed || typeof token !== "string") return;
    const lease = leases.get(token);
    if (!lease || lease.started || lease.senderId !== event.sender.id || Date.now() >= lease.expiresAt || !lease.current() ||
      ports.authorize(event, lease.identity) !== lease.authority || !existsSync(lease.file)) return;
    lease.started = true;
    try { ports.start(event, lease.file); } catch { lease.started = false; }
  };
  ipc.on(ARTIFACT_DRAG_START_CHANNEL, start);
  return { dispose() {
    disposed = true; clearInterval(timer);
    for (const controller of controllers) controller.abort();
    ipc.removeHandler(ARTIFACT_DRAG_PREPARE_CHANNEL); ipc.removeListener(ARTIFACT_DRAG_START_CHANNEL, start);
    // Started snapshots stay available for OS copies; the next process sweeps abandoned files.
    for (const lease of leases.values()) if (!lease.started) void remove(lease);
  } };
}
