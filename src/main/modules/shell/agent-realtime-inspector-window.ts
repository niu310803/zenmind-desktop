import { BrowserWindow } from "electron";
import { PRODUCT_NAME } from "../../../shared/brand";

type AgentRealtimeInspectorWindowControllerOptions = {
  preloadPath: string;
  routePath: string;
  platform: NodeJS.Platform;
  loadRendererRoute: (targetWindow: BrowserWindow, routePath: string) => Promise<unknown>;
  onRendererError: (message: string, details: unknown) => void;
  onOpenChange: (open: boolean) => void;
};

export class AgentRealtimeInspectorWindowController {
  private readonly options: AgentRealtimeInspectorWindowControllerOptions;
  private window: BrowserWindow | null = null;

  constructor(options: AgentRealtimeInspectorWindowControllerOptions) {
    this.options = options;
  }

  async open() {
    const existingWindow = this.getWindow();
    if (existingWindow) {
      if (existingWindow.isMinimized()) existingWindow.restore();
      existingWindow.show();
      existingWindow.focus();
      existingWindow.moveTop();
      return { ok: true };
    }

    const targetWindow = this.createWindow();
    try {
      await this.options.loadRendererRoute(targetWindow, this.options.routePath);
    } catch (error) {
      this.options.onRendererError("agent realtime inspector failed to load", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!targetWindow.isDestroyed()) targetWindow.destroy();
      throw error;
    }
    if (targetWindow.isDestroyed()) return { ok: false };
    if (!targetWindow.isVisible()) targetWindow.show();
    targetWindow.focus();
    targetWindow.moveTop();
    return { ok: true };
  }

  close() {
    const targetWindow = this.getWindow();
    if (targetWindow) targetWindow.close();
    return { ok: true };
  }

  getWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private createWindow() {
    const commonWindowOptions: Electron.BrowserWindowConstructorOptions = {
      width: 1480,
      height: 920,
      minWidth: 900,
      minHeight: 600,
      show: false,
      frame: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      modal: false,
      title: `${PRODUCT_NAME} Agent Realtime Inspector`,
      backgroundColor: "#202124",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        sandbox: false,
        webSecurity: true,
      },
    };

    // This is intentionally a top-level window instead of a child window so it can
    // remain visible and independently movable while the user changes Agent surfaces.
    if (this.options.platform === "darwin") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false,
        titleBarStyle: "default",
      });
    } else if (this.options.platform === "win32") {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false,
        autoHideMenuBar: true,
      });
    } else {
      this.window = new BrowserWindow({
        ...commonWindowOptions,
        skipTaskbar: false,
        transparent: false,
      });
    }

    const targetWindow = this.window;
    targetWindow.setMenuBarVisibility(false);
    targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    targetWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    targetWindow.webContents.on("will-redirect", (event) => event.preventDefault());
    targetWindow.once("ready-to-show", () => {
      if (targetWindow.isDestroyed()) return;
      targetWindow.show();
      targetWindow.focus();
    });
    targetWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      this.options.onRendererError("agent realtime inspector renderer failed to load", {
        errorCode,
        errorDescription,
        validatedUrl,
      });
    });
    targetWindow.webContents.on("render-process-gone", (_event, details) => {
      this.options.onRendererError("agent realtime inspector renderer exited unexpectedly", details);
      if (!targetWindow.isDestroyed()) targetWindow.destroy();
    });
    targetWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
      this.options.onRendererError("agent realtime inspector preload failed", {
        preloadPath,
        error: error?.stack || String(error),
      });
      if (!targetWindow.isDestroyed()) targetWindow.destroy();
    });
    targetWindow.once("closed", () => {
      if (this.window !== targetWindow) return;
      this.window = null;
      this.options.onOpenChange(false);
    });
    this.options.onOpenChange(true);
    return targetWindow;
  }
}
