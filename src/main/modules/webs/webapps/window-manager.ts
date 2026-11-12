import {
  BrowserWindow,
  WebContentsView,
  shell,
  type App,
  type WebContents
} from "electron";
import type {
  WebappCommandResult,
  WebappEntry,
  WebappRuntimeState
} from "../../../../shared/contracts";
import { t } from "../../../support/i18n/main-i18n";
import { webappRuntime, type WebappRuntime } from "./runtime";
import { readWebappItems } from "./store";
import type { WebsIntegrationPorts } from "../integration-ports";
import { DESKTOP_BROWSER_WEBVIEW_PARTITION } from "../../../../shared/browser-surfaces";
import { waitForWebappGuestsClosed } from "./guest-lifecycle";

type WebappWindowRecord = {
  window: BrowserWindow;
  webappView: WebContentsView | null;
  ownerWindow: BrowserWindow | null;
  gatewayUrl: string;
  suppressRuntimeStop: boolean;
  replacement: { closedByUser: boolean } | null;
};

type WebappWindowDisposalChange =
  | { phase: "replacing" }
  | { phase: "replacement-finished"; state: WebappRuntimeState | null };

function findWebapp(app: App, id: string, ports?: WebsIntegrationPorts) {
  const normalizedId = id.trim();
  return readWebappItems(app, process.platform, ports)
    .find((item) => item.id === normalizedId) ?? null;
}

function fail(item: WebappEntry | null, state: WebappRuntimeState | null, message: string): WebappCommandResult {
  return {
    ok: false,
    item,
    state,
    message
  };
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function isAllowedWebappWindowNavigation(targetUrl: string, gatewayUrl: string) {
  const target = parseHttpUrl(targetUrl);
  const gateway = parseHttpUrl(gatewayUrl);
  return Boolean(target && gateway && target.origin === gateway.origin);
}

export function isSafeWebappExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function resolveOwnerWindow(sender?: WebContents | null) {
  if (!sender || sender.isDestroyed()) {
    return null;
  }
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  return ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildWebappWindowShellHtml(title: string) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="color-scheme" content="light dark">
    <title>${safeTitle}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        background: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #111827; }
      }
    </style>
  </head>
  <body></body>
</html>`;
}

function buildWindowOptions(app: App, item: WebappEntry) {
  const commonOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    title: item.label,
    modal: false,
    backgroundColor: "#FFFFFF",
    webPreferences: {
      partition: DESKTOP_BROWSER_WEBVIEW_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  };

  if (process.platform === "darwin") {
    return {
      ...commonOptions,
      titleBarStyle: "default" as const
    };
  }
  if (process.platform === "win32") {
    return {
      ...commonOptions,
      autoHideMenuBar: true
    };
  }
  return commonOptions;
}

export class WebappWindowManager {
  private readonly windows = new Map<string, WebappWindowRecord>();
  private readonly closingGuests = new Map<string, WebContents>();
  private readonly disposingIds = new Map<string, number>();
  private disposalListener: ((id: string, change?: WebappWindowDisposalChange) => void | Promise<void>) | null = null;

  constructor(
    private readonly integrationPorts?: WebsIntegrationPorts,
    private readonly runtime: WebappRuntime = webappRuntime
  ) {}

  setDisposalListener(listener: ((id: string, change?: WebappWindowDisposalChange) => void | Promise<void>) | null) {
    this.disposalListener = listener;
  }

  has(id: string) {
    const record = this.windows.get(id.trim());
    return Boolean(record && !record.window.isDestroyed());
  }

  getWindow(id: string) {
    const record = this.windows.get(id.trim());
    return record && !record.window.isDestroyed() ? record.window : null;
  }

  focus(id: string, fallbackWindow: BrowserWindow | null = null) {
    const targetWindow = this.getWindow(id) ?? (
      fallbackWindow && !fallbackWindow.isDestroyed() ? fallbackWindow : null
    );
    if (!targetWindow) {
      return false;
    }
    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.show();
    targetWindow.focus();
    targetWindow.moveTop();
    return true;
  }

  openIds() {
    return [...this.windows.entries()]
      .filter(([, record]) => !record.window.isDestroyed())
      .map(([id]) => id);
  }

  async closeForDisposal(id: string) {
    const normalizedId = id.trim();
    const record = this.windows.get(normalizedId);
    const guest = record?.webappView?.webContents ?? this.closingGuests.get(normalizedId);
    const guestClosed = waitForWebappGuestsClosed(guest ? [guest] : []);
    const presentationClosed = this.disposalListener?.(normalizedId);
    this.close(normalizedId);
    const [, closed] = await Promise.all([presentationClosed, guestClosed]);
    if (!closed) throw new Error(t("webapp.pageCloseTimedOut"));
  }

  beginReplacement(id: string) {
    const normalizedId = id.trim();
    const record = this.windows.get(normalizedId);
    const view = record?.webappView;
    const guest = view?.webContents ?? this.closingGuests.get(normalizedId);
    const replacement = { closedByUser: false };
    if (record) record.replacement = replacement;
    let suspension: Promise<void> | undefined;
    let finished: Promise<void> | undefined;

    return {
      suspend: () => suspension ??= (async () => {
        const presentationClosed = (async () => this.disposalListener?.(normalizedId, { phase: "replacing" }))();
        const guestClosed = (async () => {
          const closed = waitForWebappGuestsClosed(guest ? [guest] : []);
          if (record && view && record.webappView === view) this.detachGuest(normalizedId, record);
          if (!await closed) throw new Error(t("webapp.pageCloseTimedOut"));
        })();
        // Both waits must settle even if the renderer fails before the native
        // guest finishes closing. A later open still checks the closing guest.
        const results = await Promise.allSettled([presentationClosed, guestClosed]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      })(),
      finish: (app: App, state: WebappRuntimeState | null) => finished ??= (async () => {
        let restoredState: WebappRuntimeState | null = null;
        try {
          const suspended = suspension && await suspension.then(() => true, () => false);
          if (state?.id === normalizedId) {
            const currentState = this.runtime.getStatus(app, normalizedId);
            if (currentState?.version === state.version) restoredState = currentState;
          }
          if (suspended && restoredState?.status === "running" && restoredState.webUrl && record &&
              this.windows.get(normalizedId) === record && !record.window.isDestroyed() &&
              !record.webappView && !this.closingGuests.has(normalizedId)) {
            const item = findWebapp(app, normalizedId, this.integrationPorts);
            if (!item || item.version !== restoredState.version) throw new Error(t("webapp.notFound"));
            const gatewayUrl = restoredState.webUrl;
            const nextView = this.attachGuest(app, item, record, gatewayUrl);
            // The new guest is attached. Slow page resources must not hold
            // the installation lease or delay the renderer's own restoration.
            void nextView.webContents.loadURL(gatewayUrl).catch((error) => {
              if (this.windows.get(normalizedId) === record && record.webappView === nextView) {
                console.warn(`[webapp-window] failed to restore ${normalizedId}`, error);
              }
            });
          }
        } catch (error) {
          if (!record || this.windows.get(normalizedId) === record) {
            console.warn(`[webapp-window] failed to restore ${normalizedId}`, error);
          }
        } finally {
          if (record?.replacement === replacement) record.replacement = null;
          if (replacement.closedByUser) {
            restoredState = null;
            // The native close button was used while the installer owned stop.
            // Honor that request now that the transaction has finished.
            await this.stopAfterNativeClose(app, normalizedId, record?.ownerWindow ?? null);
          }
          if (suspension) {
            try {
              await this.disposalListener?.(normalizedId, { phase: "replacement-finished", state: restoredState });
            } catch (error) {
              console.warn(`[webapp-window] failed to notify replacement completion for ${normalizedId}`, error);
            }
          }
        }
      })()
    };
  }

  beginDisposal(id: string, options: { closeImmediately?: boolean; preventRuntimeStart?: boolean } = {}) {
    const normalizedId = id.trim();
    const previousCount = this.disposingIds.get(normalizedId) ?? 0;
    this.disposingIds.set(normalizedId, previousCount + 1);
    // Package replacement keeps its UI closed while starting the new runtime
    // for health validation. Explicit stop/removal also blocks runtime starts.
    const releaseRuntime = options.preventRuntimeStart
      ? this.runtime.beginDisposal(normalizedId)
      : null;
    if (previousCount === 0 && options.closeImmediately !== false) {
      void this.closeForDisposal(normalizedId).catch((error) => {
        console.warn(`[webapp-window] failed to close ${normalizedId}`, error);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseRuntime?.();
      const nextCount = (this.disposingIds.get(normalizedId) ?? 1) - 1;
      if (nextCount > 0) this.disposingIds.set(normalizedId, nextCount);
      else this.disposingIds.delete(normalizedId);
    };
  }

  async open(app: App, id: string, sender?: WebContents | null): Promise<WebappCommandResult> {
    const normalizedId = id.trim();
    const item = findWebapp(app, normalizedId, this.integrationPorts);
    if (!item) {
      return fail(null, null, t("webapp.notFound"));
    }
    if (this.disposingIds.has(normalizedId) || this.runtime.isDisposing(normalizedId) || this.closingGuests.has(normalizedId)) {
      return fail(item, this.runtime.getStatus(app, normalizedId), t("webapp.removing"));
    }

    const existing = this.windows.get(normalizedId);
    if (existing?.webappView && !existing.webappView.webContents.isDestroyed() && this.focus(normalizedId)) {
      return {
        ok: true,
        item,
        state: this.runtime.getStatus(app, normalizedId),
        message: t("webapp.started", { label: item.label })
      };
    }
    const command = await this.runtime.start(app, normalizedId);
    if (this.disposingIds.has(normalizedId) || this.runtime.isDisposing(normalizedId) || this.closingGuests.has(normalizedId)) {
      return fail(item, command.state, t("webapp.removing"));
    }
    const gatewayUrl = command.state?.webUrl ?? "";
    if (!command.ok || !command.state || !gatewayUrl) {
      return command;
    }

    // Concurrent callers may have shared the same runtime start. Check again
    // before creating a shell or attaching another guest.
    const current = this.windows.get(normalizedId);
    const existingShell = current && !current.window.isDestroyed() ? current : null;
    if (existingShell?.webappView && !existingShell.webappView.webContents.isDestroyed()) {
      this.focus(normalizedId);
      return command;
    }
    const record = existingShell ?? this.createShell(app, item, resolveOwnerWindow(sender));
    let view: WebContentsView | undefined;
    try {
      if (record.webappView) this.detachGuest(normalizedId, record);
      view = this.attachGuest(app, item, record, gatewayUrl);
      const shellUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(buildWebappWindowShellHtml(item.label))}`;
      await Promise.all([
        existingShell ? undefined : record.window.loadURL(shellUrl),
        view.webContents.loadURL(gatewayUrl)
      ]);
      if (this.windows.get(normalizedId) !== record || record.webappView !== view || record.replacement) {
        return fail(item, command.state, t("webapp.removing"));
      }
      this.layoutGuest(record);
      if (existingShell) this.focus(normalizedId);
      return command;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A retired load can fail after replacement or a later open. It must
      // never remove the current window or stop the new runtime.
      if (this.windows.get(normalizedId) !== record || (view && record.webappView !== view) || record.replacement) {
        return fail(item, command.state, message);
      }
      this.close(normalizedId);
      const stopped = await this.runtime.stop(app, normalizedId).catch(() => null);
      return fail(item, stopped?.state ?? command.state, message);
    }
  }

  private createShell(app: App, item: WebappEntry, ownerWindow: BrowserWindow | null): WebappWindowRecord {
    const id = item.id;
    const targetWindow = new BrowserWindow(buildWindowOptions(app, item));
    const record: WebappWindowRecord = {
      window: targetWindow,
      webappView: null,
      ownerWindow,
      gatewayUrl: "",
      suppressRuntimeStop: false,
      replacement: null
    };
    this.windows.set(id, record);

    targetWindow.setMenuBarVisibility(false);
    targetWindow.on("resize", () => this.layoutGuest(record));
    targetWindow.webContents.on("did-finish-load", () => this.layoutGuest(record));
    targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    targetWindow.once("ready-to-show", () => {
      if (this.windows.get(id) !== record || targetWindow.isDestroyed()) return;
      if (record.replacement) targetWindow.showInactive();
      else this.focus(id);
    });
    targetWindow.on("closed", () => {
      const wasCurrent = this.windows.get(id) === record;
      if (wasCurrent) this.windows.delete(id);
      try {
        this.detachGuest(id, record);
      } catch (error) {
        console.warn(`[webapp-window] failed to close guest for ${id}`, error);
      }
      if (!wasCurrent || record.suppressRuntimeStop) return;
      if (record.replacement) {
        record.replacement.closedByUser = true;
        return;
      }
      void this.stopAfterNativeClose(app, id, record.ownerWindow);
    });
    return record;
  }

  private attachGuest(app: App, item: WebappEntry, record: WebappWindowRecord, gatewayUrl: string) {
    const webappView = new WebContentsView({
      webPreferences: {
        preload: this.authPreloadPath || undefined,
        partition: DESKTOP_BROWSER_WEBVIEW_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !app.isPackaged
      }
    });
    const targetWindow = record.window;
    record.webappView = webappView;
    record.gatewayUrl = gatewayUrl;
    targetWindow.setTitle(item.label);
    targetWindow.contentView.addChildView(webappView);
    this.layoutGuest(record);
    webappView.webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      if (record.webappView === webappView && !targetWindow.isDestroyed()) targetWindow.setTitle(item.label);
    });
    webappView.webContents.on("will-navigate", (event, url) => {
      const currentGuest = record.webappView === webappView;
      if (currentGuest && isAllowedWebappWindowNavigation(url, record.gatewayUrl)) return;
      event.preventDefault();
      if (currentGuest && isSafeWebappExternalUrl(url)) {
        void shell.openExternal(url).catch(() => undefined);
      }
    });
    webappView.webContents.setWindowOpenHandler(({ url }) => {
      if (record.webappView !== webappView) return { action: "deny" };
      if (isAllowedWebappWindowNavigation(url, record.gatewayUrl)) {
        void webappView.webContents.loadURL(url).catch(() => undefined);
      } else if (isSafeWebappExternalUrl(url)) {
        void shell.openExternal(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    return webappView;
  }

  private layoutGuest(record: WebappWindowRecord) {
    const view = record.webappView;
    if (!view || record.window.isDestroyed() || view.webContents.isDestroyed()) return;
    const { width, height } = record.window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  private detachGuest(id: string, record: WebappWindowRecord) {
    const view = record.webappView;
    if (!view) return;
    record.webappView = null;
    record.gatewayUrl = "";
    const guest = view.webContents;
    if (!guest.isDestroyed()) {
      this.closingGuests.set(id, guest);
      guest.once("destroyed", () => {
        if (this.closingGuests.get(id) === guest) this.closingGuests.delete(id);
      });
    }
    try {
      if (!record.window.isDestroyed()) record.window.contentView.removeChildView(view);
    } finally {
      if (!guest.isDestroyed()) guest.close();
    }
  }

  private async stopAfterNativeClose(app: App, id: string, ownerWindow: BrowserWindow | null) {
    try {
      const result = await this.runtime.stop(app, id);
      if (!result.ok) console.warn(`[webapp-window] failed to stop ${id}: ${result.message}`);
    } catch (error) {
      console.warn(`[webapp-window] failed to stop ${id}`, error);
    }
    try {
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        ownerWindow.webContents.send("webs.changed", { changedAt: new Date().toISOString() });
      }
    } catch (error) {
      console.warn(`[webapp-window] failed to notify close for ${id}`, error);
    }
  }

  close(id: string) {
    const normalizedId = id.trim();
    const record = this.windows.get(normalizedId);
    if (!record) {
      return;
    }
    record.suppressRuntimeStop = true;
    this.windows.delete(normalizedId);
    if (!record.window.isDestroyed()) {
      record.window.destroy();
    }
  }

  closeAll() {
    const openIds = this.openIds();
    for (const id of openIds) {
      this.close(id);
    }
    return openIds;
  }

  private authPreloadPath = "";
  setAuthPreloadPath(value: string) { this.authPreloadPath = value; }

  resolveAuthGuest(contents: WebContents): string | null {
    for (const [id, record] of this.windows) {
      if (!record.window.isDestroyed() && record.webappView?.webContents === contents &&
          isAllowedWebappWindowNavigation(contents.getURL(), record.gatewayUrl)) return id;
    }
    return null;
  }

  async reload(id: string, state: WebappRuntimeState | null) {
    const normalizedId = id.trim();
    const record = this.windows.get(normalizedId);
    const view = record?.webappView;
    const gatewayUrl = state?.webUrl ?? "";
    if (!record || !view || view.webContents.isDestroyed() || record.window.isDestroyed() || record.replacement || !gatewayUrl) {
      return;
    }
    record.gatewayUrl = gatewayUrl;
    try {
      await view.webContents.loadURL(gatewayUrl);
    } catch (error) {
      if (this.windows.get(normalizedId) === record && record.webappView === view && !record.replacement) throw error;
    }
  }
}

export const webappWindowManager = new WebappWindowManager();

export function createWebappWindowManager(
  ports: WebsIntegrationPorts,
  runtime: WebappRuntime
) {
  return new WebappWindowManager(ports, runtime);
}
