import { contextBridge, ipcRenderer } from "electron";
import { WEBAPP_AUTH_CHANNEL, pageAuthGlobal, type WebappAuthSessionInput } from "../shared/webapp-auth";
import { BRAND_ID } from "../shared/brand";

/** Transport only; Main owns surface, session, origin and per-exchange consent. */
export function installPageAuth() {
  if (!process.isMainFrame || !["http:", "https:"].includes(location.protocol)) return;
  contextBridge.exposeInMainWorld(pageAuthGlobal(BRAND_ID), Object.freeze({
    createSession(input: WebappAuthSessionInput) {
      return ipcRenderer.invoke(WEBAPP_AUTH_CHANNEL, input);
    }
  }));
}
