import { useEffect, useRef } from "react";
import { CloseOutlined } from "@ant-design/icons";
import { ServiceWebviewSurface } from "../../service-webview/ServiceWebviewSurface";
import { createAgentWebclientChatPreviewPath } from "../../../shared/agent-webclient-routes";
import { createSurfaceIdentity } from "../../../shared/surface-identity";
import type { TranslateFunction } from "../../../shared/i18n";

export function WebappChatDialog({ chatId, hostTheme, t, onClose }: {
  chatId: string;
  hostTheme: "light" | "dark";
  t: TranslateFunction;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onClose]);
  const path = createAgentWebclientChatPreviewPath({ chatId });
  return (
    <div className="chat-history-dialog-layer" onMouseDown={onClose}>
      <section className="chat-history-dialog webapp-chat-dialog" role="dialog" aria-modal="true"
        aria-label={t("kanban.chat.history")} onMouseDown={event => event.stopPropagation()}>
        <header className="webapp-chat-dialog-header">
          <span>{t("kanban.chat.history")}</span>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("common.close")}><CloseOutlined /></button>
        </header>
        <div className="webapp-chat-dialog-surface">
          <ServiceWebviewSurface key={chatId} active ownerChatId={chatId} hostTheme={hostTheme}
            serviceId="agent-webclient" surfaceIdentity={createSurfaceIdentity("kanban-chat")}
            surfaceLabel={t("kanban.chat.history")} desktopRoute={path} embedPath={path}
            skipContextRegistration loadInitialEmbeddedUrlDirectly suppressInitialLoadingCopy />
        </div>
      </section>
    </div>
  );
}
