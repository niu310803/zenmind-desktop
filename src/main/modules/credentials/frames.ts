import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents, WebFrameMain } from "electron";
import {
  WEBSITE_CREDENTIAL_FRAME_RESULT_CHANNEL,
  WEBSITE_CREDENTIAL_FRAME_RUN_CHANNEL,
  WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID
} from "../../../shared/website-credentials";

/** The parts of a frame that credentials use. A frame's origin is read here, never from its page. */
export type CredentialFrame = Pick<WebFrameMain, "frameToken" | "frameTreeNodeId" | "origin" | "send" | "isDestroyed" | "detached"> & {
  readonly parent: unknown;
};

/** A guest page and its frame tree; the main frame is listed first in `framesInSubtree`. */
export type CredentialPage = Pick<WebContents, "executeJavaScriptInIsolatedWorld" | "isDestroyed"> & {
  readonly mainFrame?: { readonly framesInSubtree: CredentialFrame[] };
};

/** Runs one script in the isolated world of one frame. An iframe that does not answer within `timeoutMs` fails. */
export type FrameScriptRunner = (code: string, timeoutMs?: number) => Promise<unknown>;

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };

/** True once the frame's document host is gone: navigated to another process or removed from the page. */
export function frameIsGone(frame: CredentialFrame) {
  try {
    return frame.isDestroyed() || frame.detached;
  } catch {
    return true;
  }
}

/** The page's iframes, without the main frame, in document order. */
export function childFrames(page: CredentialPage): CredentialFrame[] {
  try {
    return (page.mainFrame?.framesInSubtree ?? []).filter(frame => frame.parent);
  } catch {
    return [];
  }
}

/**
 * Main's side of the iframe relay in the web guest preload (`src/preload/login-frame-relay.ts`).
 * A frame that never answers — no relay, navigated away, hung — fails after `timeoutMs`.
 */
export function createLoginFrameRelay(ipcMain: Pick<IpcMain, "on">, timers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout)
}) {
  const pending = new Map<string, { frameToken: string; settle(ok: boolean, value?: unknown): void }>();
  ipcMain.on(WEBSITE_CREDENTIAL_FRAME_RESULT_CHANNEL, (event: { senderFrame?: { frameToken?: string } | null }, reply: unknown) => {
    const { id, ok, value } = (reply ?? {}) as { id?: unknown; ok?: unknown; value?: unknown };
    const request = typeof id === "string" ? pending.get(id) : undefined;
    // Only the frame that was asked can answer, so no frame can settle another frame's script.
    if (!request || event.senderFrame?.frameToken !== request.frameToken) return;
    request.settle(ok === true, value);
  });

  return {
    run(frame: CredentialFrame, code: string, timeoutMs: number): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (frameIsGone(frame)) return reject(new Error("frame is gone"));
        const id = randomUUID();
        const settle = (ok: boolean, value?: unknown) => {
          if (!pending.delete(id)) return;
          timers.clear(timer);
          if (ok) resolve(value); else reject(new Error("frame script failed"));
        };
        const timer = timers.set(() => settle(false), timeoutMs);
        pending.set(id, { frameToken: frame.frameToken, settle });
        try {
          frame.send(WEBSITE_CREDENTIAL_FRAME_RUN_CHANNEL, { id, code });
        } catch {
          settle(false);
        }
      });
    },

    pendingCount: () => pending.size
  };
}

export type LoginFrameRelay = ReturnType<typeof createLoginFrameRelay>;

/**
 * Runs scripts in one frame's isolated world: Electron does it directly for the main frame
 * (`frame` null or without a parent), the relay for an iframe. Null when an iframe cannot be reached.
 */
export function frameScriptRunner(
  page: Pick<CredentialPage, "executeJavaScriptInIsolatedWorld">,
  frame: CredentialFrame | null,
  relay: LoginFrameRelay | null,
  defaultTimeoutMs: number
): FrameScriptRunner | null {
  if (!frame?.parent) return code => page.executeJavaScriptInIsolatedWorld(WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID, [{ code }]);
  if (!relay) return null;
  return (code, timeoutMs = defaultTimeoutMs) => relay.run(frame, code, timeoutMs);
}
