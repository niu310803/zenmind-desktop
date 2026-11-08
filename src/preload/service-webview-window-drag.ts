import { ipcRenderer } from "electron";
import { createWindowDragClickTracker } from "../shared/window-drag-click-tracker";
import { WEBCLIENT_WINDOW_DRAG_CHANNEL as channel, WEBCLIENT_WINDOW_DRAG_HEIGHT,
  type WebclientWindowDragAction } from "../shared/webclient-window-drag";

// Only the existing Main Chat TopNav's empty layout containers are draggable.
// Content (including non-button status/name/usage UI) keeps all pointer events.
export function isWebclientHeaderBlank(target: Element | null, y: number, height: number) {
  if (!target || y < 0 || y >= Math.min(height, WEBCLIENT_WINDOW_DRAG_HEIGHT)) return false;
  const inner = target.closest(".top-nav-inner");
  const nav = inner?.parentElement ?? (target.matches("nav") && target.querySelector(":scope > .top-nav-inner") ? target : null);
  if (!nav || nav.tagName !== "NAV" || y >= nav.getBoundingClientRect().bottom) return false;
  if (target !== nav && !target.matches(".top-nav-inner, .nav-group")) return false;
  if (target.closest('button,a,input,textarea,select,[role],[contenteditable],[title],[data-no-drag]')) return false;
  return !Array.from(target.childNodes).some(node => node.nodeType === 3 && node.textContent?.trim());
}

export function installServiceWebviewWindowDrag() {
  if (!process.isMainFrame) return;
  const documentId = crypto.randomUUID();
  let height = 0;
  let pointerId: number | null = null;
  let capture: Element | null = null;
  let restoreFrame: number | null = null;
  const clicks = createWindowDragClickTracker<Element>();
  const send = (action: WebclientWindowDragAction) => ipcRenderer.sendToHost(channel,
    { version: "1.0", documentId, origin: window.location.origin, action });
  function finish(event?: PointerEvent) {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    const id = pointerId;
    pointerId = null;
    if (restoreFrame !== null) { window.cancelAnimationFrame(restoreFrame); restoreFrame = null; }
    if (event?.type === "pointerup") clicks.release(event); else clicks.reset();
    try { if (capture?.hasPointerCapture(id)) capture.releasePointerCapture(id); } catch { /* Guest is closing. */ }
    capture = null;
    send("end");
  }
  ipcRenderer.on(channel, (_event, config: unknown) => {
    if (!config || typeof config !== "object") return;
    const data = config as { documentId?: unknown; height?: unknown };
    if (data.documentId !== documentId) return;
    height = typeof data.height === "number" && Number.isFinite(data.height)
      ? Math.max(0, Math.min(WEBCLIENT_WINDOW_DRAG_HEIGHT, data.height)) : 0;
    if (!height) { finish(); clicks.reset(); }
  });
  // Wait for the host to install its relay, including after a guest reload.
  ipcRenderer.on(`${channel}:request`, () => send("ready"));
  window.addEventListener("pointerdown", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!event.isTrusted || event.button !== 0 || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      !isWebclientHeaderBlank(target, event.clientY, height)) { clicks.reset(); return; }
    finish();
    pointerId = event.pointerId;
    capture = target;
    clicks.begin(target!, event);
    event.preventDefault();
    event.stopPropagation();
    try { target!.setPointerCapture(event.pointerId); } catch { /* Blur and host teardown also end the drag. */ }
    send("begin");
  }, true);
  window.addEventListener("pointermove", event => {
    if (event.pointerId === pointerId) clicks.move(event);
  }, true);
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", finish, true);
  window.addEventListener("mouseup", event => { if (event.button === 0) finish(); }, true);
  window.addEventListener("lostpointercapture", event => {
    if (event.pointerId !== pointerId) return;
    if (!event.buttons) { finish(); return; }
    // macOS activation can release capture during the first press. Restore it
    // after focus settles so the eventual release still ends that same drag.
    if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
    restoreFrame = window.requestAnimationFrame(() => {
      restoreFrame = null;
      if (pointerId !== null) {
        try { capture?.setPointerCapture(pointerId); } catch { finish(); }
      }
    });
  }, true);
  window.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.isTrusted && event.button === 0 && !event.defaultPrevented &&
      isWebclientHeaderBlank(target, event.clientY, height) && clicks.click(target!, event.detail)) {
      event.preventDefault(); event.stopPropagation(); send("maximize");
    }
  }, true);
  window.addEventListener("blur", event => { if (event.target === window) finish(); });
  window.addEventListener("pagehide", () => { height = 0; finish(); clicks.reset(); }, { once: true });
  send("ready");
}
