import type { DesktopActionBridgeOptions } from "./action-contracts";
import type { WebappEntry } from "../../../shared/contracts";
import { ConnectorError } from "./webapp-platform-client";

export async function selectWebappAssistantAgent(options: DesktopActionBridgeOptions, item: WebappEntry, requestedAgentKey?: unknown) {
  if (item.hosting === "platform") throw new ConnectorError("assistant_agent_unavailable");
  if (requestedAgentKey !== undefined) {
    if (typeof requestedAgentKey !== "string" || !requestedAgentKey.trim() || requestedAgentKey.length > 256) throw new ConnectorError("invalid_args");
    const agents = await options.assistantBridge.listAgents();
    if (!agents.some(agent => agent.agentKey === requestedAgentKey)) throw new ConnectorError("assistant_agent_unavailable");
    return requestedAgentKey;
  }
  let agentKey = item.copilot?.agentKey ?? options.getAssistantSettings(options.app).desktopHelperAgentKey;
  const field = item.userConfig?.fields.find(field => field.type === "select" && "source" in field && field.source === "desktop.agents");
  const values = options.webs.webappManager.readUserConfig(options.app, item.id);
  const selected = field && typeof values[field.name] === "string" ? String(values[field.name]) : "";
  if (selected) {
    const agents = await options.assistantBridge.listAgents().catch(() => []);
    if (!agents.some(agent => agent.agentKey === selected)) throw new ConnectorError("assistant_agent_unavailable");
    agentKey = selected;
  }
  if (!agentKey?.trim()) throw new ConnectorError("assistant_agent_unavailable");
  return agentKey;
}
