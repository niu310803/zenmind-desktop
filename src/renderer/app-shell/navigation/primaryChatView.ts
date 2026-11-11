import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { createAgentWebclientAgentPath, createAgentWebclientRoute } from "../../../shared/agent-webclient-routes";

export function isBotAgent(agent: Pick<AssistantNavAgentItem, "mode">): boolean {
  return agent.mode?.trim().toUpperCase() === "BOT";
}
export function selectBotNavigationAgents(agents: AssistantNavAgentItem[]): AssistantNavAgentItem[] {
  return agents.filter(isBotAgent);
}
/** A primary pointer is never inferred from recency, pins or project previews. */
export function primaryChatNavigationTarget(agent: AssistantNavAgentItem, nonce = Date.now()): string {
  return agent.primaryChat?.chatId
    ? createAgentWebclientRoute({ agentKey: agent.agentKey, chatId: agent.primaryChat.chatId })
    : `${createAgentWebclientAgentPath(agent.agentKey)}?newChat=${nonce}&primaryNewChat=true`;
}
/**
 * Leaving a removed current Chat without another Chat to open. A bare Agent route has no
 * Chat identity Main Chat can commit, so its composer could never send; target a new Chat.
 */
export function removedChatFallbackTarget(
  agentKey: string,
  agent: AssistantNavAgentItem | null | undefined,
  removedChatId: string,
  nonce = Date.now(),
): string {
  if (agent && isBotAgent(agent)) {
    // The navigation snapshot is refreshed only after this navigation.
    const primaryChat = agent.primaryChat?.chatId === removedChatId ? undefined : agent.primaryChat;
    return primaryChatNavigationTarget({ ...agent, primaryChat }, nonce);
  }
  return createAgentWebclientAgentPath(agentKey, new URLSearchParams({ newChat: String(nonce) }));
}
