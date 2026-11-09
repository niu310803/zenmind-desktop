import type { AssistantNavAgentItem } from "../../../shared/contracts";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { createAgentWebclientAgentPath, createAgentWebclientRoute } from "../../../shared/agent-webclient-routes";

const STORAGE_KEY = `${STORAGE_NAMESPACE}:show-bots`;
export function readPrimaryChatNavigation(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) !== "false"; } catch { return true; }
}
export function savePrimaryChatNavigation(enabled: boolean) {
  try { window.localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* Optional view preference. */ }
}
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
