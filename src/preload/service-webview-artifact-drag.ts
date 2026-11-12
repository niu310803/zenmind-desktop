import { contextBridge, ipcRenderer } from "electron";
import { ARTIFACT_DRAG_GLOBAL, ARTIFACT_DRAG_PREPARE_CHANNEL, ARTIFACT_DRAG_START_CHANNEL, type ArtifactDragBridge } from "../shared/contracts/agent-webclient-bridge";

export function installArtifactDrag() {
  if (!process.isMainFrame) return;
  let gestureUntil = 0;
  window.addEventListener("dragstart", event => {
    if (event.isTrusted) gestureUntil = performance.now() + 500;
  }, true);
  const bridge: ArtifactDragBridge = {
    version: 1,
    prepare: input => ipcRenderer.invoke(ARTIFACT_DRAG_PREPARE_CHANNEL, input),
    start(token) {
      if (performance.now() > gestureUntil || !gestureUntil) return;
      gestureUntil = 0;
      ipcRenderer.send(ARTIFACT_DRAG_START_CHANNEL, token);
    },
  };
  contextBridge.exposeInMainWorld(ARTIFACT_DRAG_GLOBAL, bridge);
}
