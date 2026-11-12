import { useEffect, useRef, useState, type HTMLAttributes } from "react";

type PreparedChat = { chatId: string; revision: number; gestureId: string; ready: boolean; expiresAt: number; failed?: boolean; requested?: boolean; message?: string };

export function useChatFileDrag(enabled: boolean, onError: (message?: string) => void) {
  const [preparingChatId, setPreparingChatId] = useState("");
  const lease = useRef<PreparedChat | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  const reportError = useRef(onError);
  reportError.current = onError;

  function cancelPreparation() {
    const current = lease.current;
    lease.current = null;
    if (current) window.electronAPI.assistant.cancelChatFileDrag(current.gestureId);
    setPreparingChatId("");
  }

  useEffect(() => {
    window.addEventListener("blur", cancelPreparation);
    return () => {
      window.removeEventListener("blur", cancelPreparation);
      cleanup.current?.(); cancelPreparation();
    };
  }, []);

  function prepare(chatId: string, revision: number) {
    const current = lease.current;
    if (current?.chatId === chatId && current.revision === revision && !current.failed && current.expiresAt > Date.now()) return;
    cancelPreparation();
    const next: PreparedChat = { chatId, revision, gestureId: crypto.randomUUID(), ready: false, expiresAt: Date.now() + 55_000 };
    lease.current = next;
    setPreparingChatId(chatId);
    void window.electronAPI.assistant.prepareChatFileDrag({ chatId, gestureId: next.gestureId }).then(result => {
      if (lease.current !== next) return;
      setPreparingChatId("");
      if (result.ok) next.ready = true;
      else {
        next.failed = true; next.message = result.message;
        if (next.requested) reportError.current(result.message);
      }
    }, () => {
      if (lease.current !== next) return;
      next.failed = true;
      setPreparingChatId("");
      if (next.requested) reportError.current();
    });
  }

  function bind(chatId: string, revision = 0): HTMLAttributes<HTMLButtonElement> {
    if (!enabled || !chatId) return {};
    return {
      "aria-busy": preparingChatId === chatId || undefined,
      draggable: true,
      onPointerEnter: () => prepare(chatId, revision),
      onFocus: () => prepare(chatId, revision),
      onClickCapture(event) {
        if (event.detail > 0 && performance.now() < suppressClickUntil.current) {
          event.preventDefault(); event.stopPropagation();
        }
      },
      onPointerDownCapture(event) {
        if (event.button !== 0 || !event.isPrimary || event.pointerType !== "mouse" ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        cleanup.current?.();
        suppressClickUntil.current = 0;
        prepare(chatId, revision);
        const node = event.currentTarget;
        node.draggable = true;
        const { clientX: x, clientY: y, pointerId } = event;
        let direction: "pending" | "export" | "sort" = "pending";
        const finish = () => {
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", release, true);
          document.removeEventListener("pointercancel", release, true);
          document.removeEventListener("keydown", key, true);
          window.removeEventListener("blur", blur);
          // Leave vertical dragging disabled until the next press. Restoring it
          // during pointercancel could accidentally start a Chromium drag.
          cleanup.current = null;
        };
        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          if (!(pointer.buttons & 1)) { finish(); return; }
          const dx = pointer.clientX - x, dy = Math.abs(pointer.clientY - y);
          if (direction === "pending" && Math.max(Math.abs(dx), dy) > 4) {
            direction = Math.abs(dx) > dy ? "export" : "sort";
            if (direction === "sort") node.draggable = false;
          }
          // Let Chromium create the real dragstart while keeping dnd-kit from
          // claiming horizontal movement. No pointer capture or async takeover.
          if (direction === "export") pointer.stopImmediatePropagation();
        };
        const release = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(); };
        const key = (keyboard: KeyboardEvent) => {
          if (keyboard.key === "Escape") {
            suppressClickUntil.current = performance.now() + 500;
            finish(); cancelPreparation();
          }
        };
        const blur = () => { finish(); cancelPreparation(); };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", release, true);
        document.addEventListener("pointercancel", release, true);
        document.addEventListener("keydown", key, true);
        window.addEventListener("blur", blur);
        cleanup.current = finish;
      },
      onDragStart(event) {
        event.preventDefault(); event.stopPropagation();
        cleanup.current?.();
        suppressClickUntil.current = performance.now() + 500;
        const current = lease.current;
        if (current?.failed) reportError.current(current.message);
        if (!current?.ready || current.chatId !== chatId || current.revision !== revision || current.expiresAt <= Date.now()) {
          // Preparing may finish after this event, but must never start a late
          // native session. The next dragstart can consume the prepared file.
          prepare(chatId, revision);
          if (lease.current) lease.current.requested = true;
          return;
        }
        lease.current = null;
        void window.electronAPI.assistant.startChatFileDrag(current.gestureId).then(result => {
          if (!result.ok) reportError.current(result.message);
        }, () => reportError.current());
      },
    };
  }
  return { bind, preparingChatId };
}
