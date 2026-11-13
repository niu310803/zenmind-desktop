import path from "node:path";
import { nativeImage } from "electron";
import { artifactDragSurfaceAllowed, registerArtifactDragIpc, registerArtifactActionIpc } from "../modules/artifacts";
import { createWebsiteCredentials, registerWebsiteCredentialIpc } from "../modules/credentials";
import { shell } from "electron";
import { callAgentPlatform } from "../modules/desktop-actions";
import { resolvePreferredAgentPlatformRuntimeRoot } from "../modules/services";
import { getTunnelHubRuntimeStatus } from "../modules/tunnel";
import { registerShellIpcHandlers } from "../modules/shell";
import { registerSidebarContextMenuIpcHandlers, registerWebsiteBridgeIpc } from "../modules/web-surfaces";
import { registerChatWorkPanelTabContextMenuIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelLocalFileIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelDocumentHtmlIpcHandlers } from "../modules/work-panel";
import { registerChatWorkPanelResourceImageIpcHandlers } from "../modules/work-panel";
import { MainIpcRegistrationOptions, PLATFORM_DOCUMENT_REVISION_HEADER } from "./ipc-registration-contracts";

export function registerShellWorkPanelIpc(options: MainIpcRegistrationOptions) {
  const {
    app,
    ipcMain,
    assistantBridgeRuntime,
    logsRuntime,
  } = options;
  const services = options.servicesFacade;
  const { assistantBridge } = assistantBridgeRuntime;
  registerShellIpcHandlers(ipcMain, {
    platform: options.platform,
    app: app as any,
    mainWindow: options.getMainWindow(),
    getMainWindow: options.getMainWindow,
    showFileDialog: options.showFileDialog,
    revealPathInFileManager: options.revealPathInFileManager,
    captureDesktopScreenshot: options.captureDesktopScreenshotForWebview,
    reportRendererDiagnostic: options.reportRendererDiagnostic,
    openLogViewerWindow: options.openLogViewerWindow,
    issueAgentPlatformAccessToken: options.issueAgentAccessToken,
    desktopLogStreamSubscriptions: logsRuntime.getDesktopLogSubscriptions(),
    setGlobalSearchOverlayVisible: options.setGlobalSearchOverlayVisible,
    setWebviewModalOverlayVisible: options.setWebviewModalOverlayVisible,
    getTunnelHubRuntimeStatus,
    setWorkPanelFullscreenActive: options.setWorkPanelFullscreenActive,
    setMainWindowSidebarCollapsed: options.setMainWindowSidebarCollapsed,
  });

  registerWebsiteBridgeIpc(ipcMain, { getMainWindow: options.getMainWindow, browserSurfaces: options.browserSurfaces, platform: options.platform });

  const websiteCredentials = createWebsiteCredentials(app, { platform: options.platform, getMainWindow: options.getMainWindow, ipcMain });
  registerWebsiteCredentialIpc(ipcMain, { getMainWindow: options.getMainWindow, ...websiteCredentials });
  options.browserSurfaces.observeWebGuests(websiteCredentials.capture);

  registerSidebarContextMenuIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow
  });

  registerChatWorkPanelTabContextMenuIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow,
    browserSurfaces: options.browserSurfaces,
    app,
    platform: options.platform,
  });

  registerChatWorkPanelLocalFileIpcHandlers(ipcMain, {
    getMainWindow: options.getMainWindow,
    getReviewPreloadUrl: () => options.getServiceWebviewPreloadUrl()
      .replace(/service-webview\.js$/u, "work-panel-preview.js"),
    showFileDialog: options.showFileDialog as any,
  });

  const fetchDocumentResource = async ({ chatId, relativePath }: { chatId: string; relativePath: string }) => {
    try {
      const state = await services.getServiceState(app, "agent-platform");
      const baseUrl = state.status === "running"
        ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
        : "";
      if (!baseUrl) return null;
      const tokenResult = await options.issueAgentAccessToken(app, "missing");
      if (!tokenResult.ok || !tokenResult.token.trim()) return null;
      const url = new URL("/api/resource", baseUrl);
      url.searchParams.set("file", `${chatId}/${relativePath}`);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${tokenResult.token.trim()}` } });
      if (!response.ok) return null;
      const declaredSize = Number(response.headers.get("content-length") || "0");
      if (declaredSize > 100 * 1024 * 1024) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 100 * 1024 * 1024) return null;
      return {
        bytes,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "",
        revision: response.headers.get(PLATFORM_DOCUMENT_REVISION_HEADER)?.trim() || "",
      };
    } catch {
      return null;
    }
  };

  const dragRuntime = registerArtifactDragIpc(ipcMain, {
    platform: options.platform,
    tempRoot: path.join(app.getPath("temp"), `${app.getName()}-artifact-drag`),
    authorize(event, identity) {
      const window = options.getMainWindow();
      if (!window || window.isDestroyed() || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null;
      if (event.sender === window.webContents) {
        if (!identity.relativePath) {
          if (!identity.artifactId) return null;
          const context = options.artifactRuntime?.actionContext({ ...identity, artifactId: identity.artifactId, runId: identity.runId || "" });
          if (!context?.record || context.record.sourceState !== "active" || context.record.contentState !== "ready" || !context.isCurrent()) return null;
        }
        return JSON.stringify(["library", window.webContents.id, event.senderFrame.processId, event.senderFrame.routingId, event.senderFrame.url]);
      }
      if (!options.isTrustedAgentWebclientSession(event.sender)) return null;
      const target = options.browserSurfaces.resolveWebviewSurfaceTarget(event.sender.id);
      if (!target || !artifactDragSurfaceAllowed(target, identity, event.sender.getURL(), window.webContents.id)) return null;
      return JSON.stringify([target.registrationId, target.surfaceIdentityKey, target.ownerChatId, event.senderFrame.processId, event.senderFrame.routingId, event.senderFrame.url]);
    },
    captureSourceGeneration: chatId => options.artifactRuntime?.captureSourceGeneration(chatId) ?? (() => false),
    getChatInfo: chatId => assistantBridge.getChatInfo(chatId),
    read: (identity, signal) => options.artifactRuntime!.read(identity, signal),
    start(event, file) {
      // Native drag needs a nonempty image on macOS; a compact document glyph works on both platforms.
      const pixels = Buffer.alloc(32 * 32 * 4);
      for (let y = 2; y < 30; y++) for (let x = 6; x < 26; x++) {
        const line = x > 9 && x < 22 && [12, 17, 22].includes(y);
        const border = x === 6 || x === 25 || y === 2 || y === 29;
        const offset = (y * 32 + x) * 4;
        pixels.fill(line || border ? 130 : 245, offset, offset + 3); pixels[offset + 3] = 255;
      }
      const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 1 });
      if (options.platform === "darwin") event.sender.startDrag({ file, icon });
      else if (options.platform === "win32") event.sender.startDrag({ file, icon });
    },
  });
  app.once("will-quit", () => dragRuntime.dispose());

  registerArtifactActionIpc(ipcMain, {
    library: options.artifactRuntime,
    app,
    fileShell: shell,
    platform: options.platform,
    getMainWindow: options.getMainWindow,
    getChatInfo: (chatId) => assistantBridge.getChatInfo(chatId),
    getRuntimeRoot: () => resolvePreferredAgentPlatformRuntimeRoot(app),
    showSaveDialog: options.showSaveDialog,
  });

  registerChatWorkPanelDocumentHtmlIpcHandlers(ipcMain, {
    app,
    showSaveDialog: options.showSaveDialog,
    getMainWindow: options.getMainWindow,
    fetchRemoteResource: fetchDocumentResource,
    commitDocument: (payload) => callAgentPlatform(app, "/api/document/commit", {
      issueAgentAccessToken: options.issueAgentAccessToken,
      method: "POST",
      body: payload,
    }),
  });

  registerChatWorkPanelResourceImageIpcHandlers(ipcMain, {
    app,
    assistantBridge,
    getMainWindow: options.getMainWindow,
    showFileDialog: options.showFileDialog as any,
    showSaveDialog: options.showSaveDialog as any,
    fetchRemoteResource: fetchDocumentResource,
    commitResource: (payload) => callAgentPlatform(app, "/api/document/commit", {
      issueAgentAccessToken: options.issueAgentAccessToken,
      method: "POST",
      body: {
        operation: "document.commit",
        source: payload.profile === "workspace-file"
          ? { kind: "workspace-file", agentKey: payload.agentKey, path: payload.relativePath }
          : {
              kind: payload.profile,
              agentKey: payload.agentKey,
              chatId: payload.chatId,
              resourceId: payload.resourceId,
              relativePath: payload.relativePath,
            },
        mode: payload.mode,
        expectedRevision: payload.expectedRevision,
        payload: {
          kind: "document-image",
          mimeType: payload.mimeType,
          dataBase64: payload.dataBase64,
        },
      },
    }),
  });

}
