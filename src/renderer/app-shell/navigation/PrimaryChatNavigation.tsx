import type { HTMLAttributes, MouseEvent, KeyboardEvent } from "react";
import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { SidebarActionIcon } from "../../components/BrandMark";
import { AgentIcon } from "./AgentIcon";
import { ChatTitle } from "./ChatTitle";
import { MaterialIcon } from "../../components/icons/MaterialIcon";
import { useI18n } from "../../i18n/useI18n";
import "./PrimaryChatNavigation.css";

type Props = {
  agents: AssistantNavAgentItem[];
  collapsed: boolean;
  currentChatId: string;
  error: string;
  onRetry: () => void;
  onOpen: (agent: AssistantNavAgentItem) => void;
  onContextMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, agent: AssistantNavAgentItem) => void;
  itemProps: (id: string) => HTMLAttributes<HTMLButtonElement>;
  fileDragProps?: (chatId: string) => HTMLAttributes<HTMLButtonElement>;
};

export function PrimaryChatNavigation(props: Props) {
  const { agents, collapsed, error, onRetry } = props;
  const { t } = useI18n();
  if (!agents.length) return null;
  return <section className={`primary-chat-navigation${collapsed ? " is-collapsed" : ""}`} aria-label={t("sidebar.primaryChats.title")}>
    {agents.map(agent => {
      const chat = agent.primaryChat;
      const active = chat?.chatId === props.currentChatId;
      const preview = chat ? (chat.lastRunContent || chat.chatName || t("sidebar.primaryChats.noReply")).replace(/\s+/gu, " ") : t("sidebar.primaryChats.noChat");
      const status = chat?.hasPendingAwaiting ? t("sidebar.agent.awaiting") : chat?.hasActiveRun ? t("sidebar.agent.running") : chat && !chat.isRead ? t("sidebar.chat.unread") : "";
      const roving = props.itemProps(`primary:${agent.agentKey}`);
      return <div key={agent.agentKey} className="primary-chat-row">
        <button data-agent-pointer-idle="" data-agent-identity="" data-primary-agent-key={agent.agentKey}
          type="button" {...roving} {...(chat && props.fileDragProps?.(chat.chatId))} className={`primary-chat-item${active ? " is-active" : ""}`}
          aria-current={active ? "page" : undefined}
          title={`${agent.displayName}\n${preview}${status ? ` · ${status}` : ""}${chat ? `\n${t("sidebar.chat.dragExportHint")}` : ""}`}
          aria-label={`${agent.displayName}, ${preview}${status ? `, ${status}` : ""}`}
          onKeyDown={event => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              props.onContextMenu(event, agent);
              return;
            }
            roving.onKeyDown?.(event);
          }}
          onContextMenu={event => props.onContextMenu(event, agent)} onClick={() => props.onOpen(agent)}>
          <AgentIcon icon={agent.icon} mode={agent.mode} size={36} />
          {!collapsed && <span className="primary-chat-body"><span className="primary-chat-name"><ChatTitle text={agent.displayName} /></span><span className="primary-chat-preview"><ChatTitle text={preview} /></span></span>}
          {status && <span className="primary-chat-status">
            {chat?.hasPendingAwaiting ? <MaterialIcon name="front_hand" size={13} /> : chat?.hasActiveRun ? <MaterialIcon name="progress_activity" size={13} className="primary-chat-spinner" /> : chat && !chat.isRead ? <span className="assistant-worker-unread-dot chat-unread-dot is-unread" /> : null}
          </span>}
        </button>
        {!collapsed && <button type="button" className="assistant-worker-chat-menu-button sidebar-more-actions-button primary-chat-history" aria-label={`${agent.displayName}: ${t("sidebar.agent.moreActions")}`}
          title={t("common.more")} tabIndex={-1} onClick={event => props.onContextMenu(event, agent)}><SidebarActionIcon kind="more_actions" /></button>}
      </div>;
    })}
    {error && <div className="primary-chat-error" role="alert">{!collapsed && <span>{error}</span>}<button type="button" title={error} onClick={onRetry}>{t("sidebar.primaryChats.retry")}</button></div>}
  </section>;
}
