import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import type { ChatFileDragResult } from "../../../shared/chat-file-drag";

export function useChatFileDrag(enabled: boolean, onError: (message?: string) => void) {
  const [preparingChatId, setPreparingChatId] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  const lastGesture = useRef("");
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
    return () => { cleanup.current?.(); };
  }, []);

  function bind(chatId: string): HTMLAttributes<HTMLButtonElement> {
    if (!enabled || !chatId) return {};
    return {
      "aria-busy": preparingChatId === chatId || undefined,
      // Suppress Chromium text/link dragging; Main starts the native file session.
      draggable: false,
      onClickCapture(event) {
        if (event.detail > 0 && performance.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onPointerDownCapture(event) {
        if (event.button !== 0 || !event.isPrimary || event.pointerType !== "mouse" ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        cleanup.current?.();
        suppressClickUntil.current = 0;
        const api = window.electronAPI.assistant;
        const node = event.currentTarget;
        const { clientX: x, clientY: y, pointerId } = event;
        const gestureId = crypto.randomUUID();
        let active = true;
        let exporting = false;
        const finish = () => {
          if (!active) return;
          active = false;
          if (exporting) {
            api.cancelChatFileDrag(gestureId);
            suppressClickUntil.current = performance.now() + 500;
          }
          setPreparingChatId("");
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", release, true);
          document.removeEventListener("pointercancel", release, true);
          document.removeEventListener("keydown", key, true);
          window.removeEventListener("blur", finish);
          if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
          cleanup.current = null;
        };
        const prepared = (result: ChatFileDragResult) => {
          // A late export must never start a drag after release, Escape or blur.
          if (!active) return;
          setPreparingChatId("");
          if (!result.ok) {
            finish();
            reportError.current(result.message);
            return;
          }
          if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
          void api.startChatFileDrag(gestureId).then(result => {
            const relevant = active && lastGesture.current === gestureId;
            finish();
            if (!result.ok && relevant) reportError.current(result.message);
          }, () => {
            const relevant = active && lastGesture.current === gestureId;
            finish();
            if (relevant) reportError.current();
          });
        };
        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          if ((pointer.buttons & 1) === 0) { finish(); return; }
          if (exporting) {
            pointer.stopImmediatePropagation();
            suppressClickUntil.current = performance.now() + 500;
            return;
          }
          const dx = pointer.clientX - x;
          const dy = Math.abs(pointer.clientY - y);
          if (Math.max(Math.abs(dx), dy) <= 6) return;
          // Commit once: vertical stays with dnd-kit; dragging right exports a file.
          if (dx <= 6 || dx <= dy) { finish(); return; }
          // Installed in pointerdown capture, before the sorting sensor. Once
          // export owns this gesture, its moves must not activate row sorting.
          pointer.stopImmediatePropagation();
          exporting = true;
          // Both desktop platforms must receive a release over a guest/webview
          // while the asynchronous export is still being prepared.
          try { node.setPointerCapture(pointerId); } catch { finish(); return; }
          lastGesture.current = gestureId;
          suppressClickUntil.current = performance.now() + 500;
          setPreparingChatId(chatId);
          void api.prepareChatFileDrag({ gestureId, chatId }).then(prepared, () => prepared({ ok: false }));
        };
        const release = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(); };
        const key = (keyboard: KeyboardEvent) => { if (keyboard.key === "Escape") finish(); };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", release, true);
        document.addEventListener("pointercancel", release, true);
        document.addEventListener("keydown", key, true);
        window.addEventListener("blur", finish);
        cleanup.current = finish;
      },
    };
  }
  return { bind, preparingChatId };
}
