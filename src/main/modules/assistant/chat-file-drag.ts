import fs from "node:fs/promises";
import path from "node:path";
import type { ChatFileDragRequest, ChatFileDragResult } from "../../../shared/chat-file-drag";
import { isChatFileDragRequest } from "../../../shared/chat-file-drag";
import { sanitizeDownloadFilename } from "../../infrastructure/filesystem/download-paths";

type ExportResult = { ok: boolean; filename: string; bytes?: Uint8Array; message?: string };
type Gesture = { id: string; directory?: string; file?: string; timeout: ReturnType<typeof setTimeout> };

/** Staged exports belong to Main; the renderer never supplies or receives a host path. */
export class ChatFileDrag {
  private gesture?: Gesture;
  private directories = new Set<string>();
  private disposed = false;

  constructor(private readonly options: {
    platform: NodeJS.Platform;
    tempDirectory: string;
    download: (chatId: string) => Promise<ExportResult>;
    prepareFile?: (file: string) => Promise<void>;
    startDrag: (file: string) => void;
    failureMessage: () => string;
  }) {}

  async prepare(request: ChatFileDragRequest): Promise<ChatFileDragResult> {
    if (this.disposed || !isChatFileDragRequest(request) ||
      (this.options.platform !== "darwin" && this.options.platform !== "win32")) {
      return { ok: false, message: this.options.failureMessage() };
    }
    this.cancel();
    const gesture: Gesture = {
      id: request.gestureId,
      timeout: setTimeout(() => this.cancel(request.gestureId), 60_000),
    };
    gesture.timeout.unref();
    this.gesture = gesture;
    try {
      const result = await this.options.download(request.chatId);
      if (this.gesture !== gesture) return { ok: false };
      if (!result.ok || !result.bytes) throw new Error(result.message || this.options.failureMessage());
      // These are host-native temp paths on each supported platform; never a service path.
      const directory = await fs.mkdtemp(path.join(this.options.tempDirectory, "zenmind-chat-drag-"));
      this.directories.add(directory);
      gesture.directory = directory;
      const basename = sanitizeDownloadFilename(result.filename, "chat.md").replace(/\.[^.]*$/u, "");
      const file = path.join(directory, `${basename || "chat"}.md`);
      await fs.writeFile(file, result.bytes, { mode: 0o600 });
      await this.options.prepareFile?.(file);
      if (this.gesture !== gesture) {
        await this.remove(directory);
        return { ok: false };
      }
      gesture.file = file;
      return { ok: true };
    } catch (error) {
      if (this.gesture === gesture) this.cancel(gesture.id);
      if (gesture.directory) await this.remove(gesture.directory);
      return { ok: false, message: error instanceof Error ? error.message : this.options.failureMessage() };
    }
  }

  start(gestureId: string): ChatFileDragResult {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== gestureId || !gesture.file) return { ok: false };
    // startDrag may enter a native nested event loop. A pointercancel/blur IPC
    // during that loop must not remove the file Finder/Explorer is copying.
    clearTimeout(gesture.timeout);
    this.gesture = undefined;
    try {
      // Finder and Explorer copy the staged file. Keep it after the native call returns.
      this.options.startDrag(gesture.file);
      const directory = gesture.directory!;
      const cleanup = setTimeout(() => void this.remove(directory), 60 * 60_000);
      cleanup.unref();
      return { ok: true };
    } catch {
      if (gesture.directory) void this.remove(gesture.directory);
      return { ok: false, message: this.options.failureMessage() };
    }
  }

  cancel(gestureId?: string) {
    const gesture = this.gesture;
    if (!gesture || (gestureId && gesture.id !== gestureId)) return;
    this.gesture = undefined;
    clearTimeout(gesture.timeout);
    if (gesture.directory) void this.remove(gesture.directory);
  }

  async dispose() {
    this.disposed = true;
    this.cancel();
    await Promise.all([...this.directories].map(directory => this.remove(directory)));
  }

  private async remove(directory: string) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    this.directories.delete(directory);
  }
}
