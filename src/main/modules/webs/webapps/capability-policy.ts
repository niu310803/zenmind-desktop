import type { WebappEntry } from "../../../../shared/contracts";
import {
  WEBAPP_BRIDGE_ACTIONS,
  resolveWebappAction,
  WEBAPP_BRIDGE_CAPABILITY_ACTIONS,
} from "../../../../shared/webapp-bridge";

export type WebappCapabilityScope = "backendActionToken" | "localPageGateway";

export function getWebappAllowedActions(item: WebappEntry, scope: WebappCapabilityScope) {
  if (item.hosting === "platform") return [];
  const actions = new Set<string>();
  if (scope === "localPageGateway") {
    actions.add(WEBAPP_BRIDGE_ACTIONS.capabilitiesList);
  }
  for (const [capability, capabilityActions] of Object.entries(WEBAPP_BRIDGE_CAPABILITY_ACTIONS)) {
    if (scope === "backendActionToken" && capability !== "mcp.invoke" && capability !== "connector.execute" && capability !== "assistant.chat" && capability !== "assistant.execute" && capability !== "skill.read" && capability !== "artifact.read" && capability !== "kanban.read") {
      continue;
    }
    for (const action of capabilityActions) {
      actions.add(action);
    }
  }

  return [...actions];
}

export function isWebappActionAllowed(
  item: WebappEntry,
  scope: WebappCapabilityScope,
  action: string
) {
  return getWebappAllowedActions(item, scope).includes(resolveWebappAction(action));
}
