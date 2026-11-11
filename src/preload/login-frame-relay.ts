import { ipcRenderer, webFrame } from "electron";
import {
  WEBSITE_CREDENTIAL_FRAME_RESULT_CHANNEL,
  WEBSITE_CREDENTIAL_FRAME_RUN_CHANNEL,
  WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID
} from "../shared/website-credentials";

/**
 * Iframes of a web guest only. Main runs its login scripts in a guest's main frame itself,
 * but Electron gives it no isolated world inside iframes, so it sends them here and this
 * relay runs them in the same isolated world of its own frame. Only Main can send on the
 * channel; page scripts reach neither the relay nor that world. Nothing is logged: a fill
 * script carries a password.
 */
export function installLoginFrameRelay() {
  // Sandboxed preload process metadata can omit isMainFrame; the DOM check covers it.
  if (window.top === window || process.isMainFrame === true) return;
  ipcRenderer.on(WEBSITE_CREDENTIAL_FRAME_RUN_CHANNEL, (_event, request: unknown) => {
    const { id, code } = (request ?? {}) as { id?: unknown; code?: unknown };
    if (typeof id !== "string" || typeof code !== "string") return;
    webFrame.executeJavaScriptInIsolatedWorld(WEBSITE_CREDENTIAL_SCRIPT_WORLD_ID, [{ code }]).then(
      value => ipcRenderer.send(WEBSITE_CREDENTIAL_FRAME_RESULT_CHANNEL, { id, ok: true, value }),
      () => ipcRenderer.send(WEBSITE_CREDENTIAL_FRAME_RESULT_CHANNEL, { id, ok: false })
    );
  });
}
