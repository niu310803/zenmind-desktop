import { WEBCLIENT_WINDOW_DRAG_CHANNEL as channel, WEBCLIENT_WINDOW_DRAG_HEIGHT,
  parseWebclientWindowDragMessage } from "../../shared/webclient-window-drag";

type DragWebview = Pick<Electron.WebviewTag, "getURL" | "send" | "addEventListener" | "removeEventListener" | "setAttribute" | "removeAttribute">;
export function createWebclientWindowDragHost(options: {
  webview: DragWebview;
  trustedUrl(): string;
  isCurrentGuest(): boolean;
  readHeight(): number;
  onEnabled?(enabled: boolean): void;
  begin(): Promise<{ ok: boolean }>;
  end(): Promise<unknown>;
  maximize(): Promise<unknown>;
}) {
  let documentId = "";
  let disposed = false;
  let dragging = false;
  let dragSequence = 0;
  let queue = Promise.resolve();
  const enqueue = (action: () => Promise<unknown>) => { queue = queue.then(action).then(() => undefined, () => undefined); };
  function trusted(origin?: string) {
    if (disposed || !options.isCurrentGuest()) return false;
    try {
      const expected = new URL(options.trustedUrl());
      const actual = new URL(options.webview.getURL());
      return ["http:", "https:"].includes(expected.protocol) && actual.origin === expected.origin &&
        (origin === undefined || origin === actual.origin);
    } catch { return false; }
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    dragSequence++;
    enqueue(() => options.end());
  }
  function refresh() {
    const height = trusted() ? Math.max(0, Math.min(WEBCLIENT_WINDOW_DRAG_HEIGHT, options.readHeight())) : 0;
    if (!height) end();
    options.webview.removeAttribute("data-window-drag-ready");
    options.onEnabled?.(false);
    if (!documentId) return;
    try {
      options.webview.send(channel, { documentId, height });
      if (height) {
        options.webview.setAttribute("data-window-drag-ready", "true");
        options.onEnabled?.(true);
      }
    } catch { end(); }
  }
  const request = (event: Event) => {
    const message = event as Event & { channel?: string; args?: unknown[] };
    if (message.channel !== channel) return;
    const data = parseWebclientWindowDragMessage(message.args?.[0]);
    if (!data || !trusted(data.origin)) return;
    if (data.action === "ready") { end(); documentId = data.documentId; refresh(); return; }
    if (data.documentId !== documentId) return;
    if (data.action === "end") { end(); return; }
    if (options.readHeight() <= 0) return;
    if (data.action === "begin" && !dragging) {
      dragging = true;
      const generation = documentId;
      const sequence = ++dragSequence;
      enqueue(async () => {
        if (!dragging || dragSequence !== sequence || documentId !== generation || !trusted() || options.readHeight() <= 0) return;
        const result = await options.begin();
        if (!result.ok && dragSequence === sequence) { dragging = false; refresh(); }
      });
    } else if (data.action === "maximize" && !dragging) {
      const generation = documentId;
      enqueue(async () => {
        if (documentId === generation && trusted() && options.readHeight() > 0) await options.maximize();
      });
    }
  };
  const reset = () => {
    end(); documentId = ""; options.webview.removeAttribute("data-window-drag-ready"); options.onEnabled?.(false);
  };
  const navigation = (event: Event) => {
    const data = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (data.isMainFrame && !data.isInPlace) reset();
  };
  const ready = () => { reset(); try { options.webview.send(`${channel}:request`); } catch { /* Guest gone. */ } };
  options.webview.addEventListener("ipc-message", request);
  options.webview.addEventListener("dom-ready", ready);
  options.webview.addEventListener("did-start-navigation", navigation);
  options.webview.addEventListener("render-process-gone", reset);
  ready();
  return { refresh, dispose() {
    try { if (documentId) options.webview.send(channel, { documentId, height: 0 }); } catch { /* Guest gone. */ }
    reset(); disposed = true;
    options.webview.removeEventListener("ipc-message", request);
    options.webview.removeEventListener("dom-ready", ready);
    options.webview.removeEventListener("did-start-navigation", navigation);
    options.webview.removeEventListener("render-process-gone", reset);
  } };
}
