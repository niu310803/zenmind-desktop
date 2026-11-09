import type { HTMLAttributes, MouseEvent, KeyboardEvent } from "react";
import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { AgentIcon } from "./AgentIcon";
import { MaterialIcon } from "../../components/icons/MaterialIcon";
import { useI18n } from "../../i18n/useI18n";
import "./PrimaryChatNavigation.css";

type Props = {
  agents: AssistantNavAgentItem[];
  enabled: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  collapsed: boolean;
  currentChatId: string;
  loaded: boolean;
  error: string;
  onRetry: () => void;
  onOpen: (agent: AssistantNavAgentItem) => void;
  onContextMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, agent: AssistantNavAgentItem) => void;
  itemProps: (id: string) => HTMLAttributes<HTMLButtonElement>;
};

export function PrimaryChatNavigation(props: Props) {
  const { agents, enabled, onEnabledChange, collapsed, loaded, error, onRetry } = props;
  const { t } = useI18n();
  return <section className={`primary-chat-navigation${collapsed ? " is-collapsed" : ""}`} aria-label={t("sidebar.primaryChats.title")}>
    <div className={`primary-chat-heading${collapsed ? " is-collapsed" : ""}`}>
      <button type="button" className="primary-chat-toggle" aria-pressed={enabled}
        aria-label={t(enabled ? "sidebar.primaryChats.standardMode" : "sidebar.primaryChats.toggle")}
        title={t(enabled ? "sidebar.primaryChats.standardMode" : "sidebar.primaryChats.toggle")}
        onClick={() => onEnabledChange?.(!enabled)}>
        <MaterialIcon name="smart_toy" size={16} />{!collapsed && <span>{t("sidebar.primaryChats.title")}</span>}
        {!collapsed && <MaterialIcon name={enabled ? "keyboard_arrow_up" : "expand_more"} size={14} />}
      </button>
    </div>
    {enabled && <>
      {agents.map(agent => {
        const chat = agent.primaryChat;
        const active = chat?.chatId === props.currentChatId;
        const preview = chat ? (chat.lastRunContent || chat.chatName || t("sidebar.primaryChats.noReply")).replace(/\s+/gu, " ") : t("sidebar.primaryChats.noChat");
        const status = chat?.hasPendingAwaiting ? t("sidebar.agent.awaiting") : chat?.hasActiveRun ? t("sidebar.agent.running") : chat && !chat.isRead ? t("sidebar.chat.unread") : "";
        const roving = props.itemProps(`primary:${agent.agentKey}`);
        return <div key={agent.agentKey} className="primary-chat-row">
          <button data-agent-pointer-idle="" data-agent-identity="" data-primary-agent-key={agent.agentKey}
            type="button" {...roving} className={`primary-chat-item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={`${agent.displayName}\n${preview}${status ? ` · ${status}` : ""}`}
            aria-label={`${agent.displayName}, ${preview}${status ? `, ${status}` : ""}`}
            onKeyDown={event => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                props.onContextMenu(event, agent);
                return;
              }
              roving.onKeyDown?.(event);
            }}
            onContextMenu={event => props.onContextMenu(event, agent)} onClick={() => props.onOpen(agent)}>
            <AgentIcon icon={agent.icon} mode={agent.mode} size={30} />
            {!collapsed && <span className="primary-chat-body"><span className="primary-chat-name">{agent.displayName}</span><span className="primary-chat-preview">{preview}</span></span>}
            <span className="primary-chat-status">
              {chat?.hasPendingAwaiting ? <MaterialIcon name="front_hand" size={13} /> : chat?.hasActiveRun ? <MaterialIcon name="progress_activity" size={13} className="primary-chat-spinner" /> : chat && !chat.isRead ? <span className="assistant-worker-unread-dot chat-unread-dot is-unread" /> : null}
            </span>
          </button>
          {!collapsed && <button type="button" className="primary-chat-history" aria-label={`${agent.displayName}: ${t("sidebar.agent.moreActions")}`}
            title={t("sidebar.agent.moreActions")} onClick={event => props.onContextMenu(event, agent)}><MaterialIcon name="more_horiz" size={15} /></button>}
        </div>;
      })}
      {error && <div className="primary-chat-error" role="alert">{!collapsed && <span>{error}</span>}<button type="button" title={error} onClick={onRetry}>{t("sidebar.primaryChats.retry")}</button></div>}
      {!error && !agents.length && !collapsed && <div className="sidebar-empty-hint" role="status">{t(loaded ? "sidebar.primaryChats.empty" : "sidebar.primaryChats.loading")}</div>}
    </>}
  </section>;
}
