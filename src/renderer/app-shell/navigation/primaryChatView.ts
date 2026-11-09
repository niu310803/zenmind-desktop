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
