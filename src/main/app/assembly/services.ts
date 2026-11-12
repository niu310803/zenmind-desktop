import { ensureProviderRegisterApiKey } from "../../modules/agent-platform";
import { resolveConversationAssetOrigin } from "../../modules/conversation-share";
import {
  getDesktopDeviceId,
  getDesktopDeviceInfo, issueAgentAccessToken
} from "../../modules/identity";
import {
  emitPluginBridgeHook,
  getPluginBridgeEnv,
  getPluginSettingsEnv,
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  stopPluginResources,
  syncPluginResources
} from "../../modules/plugins";
import {
  type ServicesIntegrationPorts
} from "../../modules/services";
import {
  type WebsFacade
} from "../../modules/webs";
export interface AssembleServicesIntegrationDependencies {
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly websFacade: Pick<WebsFacade, "webappManager">;
}

export function assembleServicesIntegration(
  dependencies: AssembleServicesIntegrationDependencies
): ServicesIntegrationPorts {
  return {
    stopWebappPlatformsForBundleReplacement: async (app) => {
      const manager = dependencies.websFacade.webappManager;
      for (const item of manager.list(app).filter(item => item.hosting === "platform")) {
        const result = await manager.runtime.stop(app, item.id);
        if (!result.ok) throw new Error(result.message);
      }
    },
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    getDesktopDeviceId,
    getDesktopDeviceInfo,
    // Grant only: login-identity providers read the SSO token file inside Platform.
    ensureProviderRegisterApiKey: (targetApp, preparation) =>
      ensureProviderRegisterApiKey(targetApp, { getDesktopDeviceId, preparation }),
    resolveConversationAssetOrigin,
    emitPluginBridgeHook,
    getPluginBridgeEnv,
    getPluginSettingsEnv,
    initializePluginResourceState,
    readPluginResourceDesiredStatus,
    stopPluginResources: (targetApp, service) =>
      stopPluginResources(targetApp, service, dependencies.websFacade.webappManager),
    syncPluginResources: (targetApp, service, installDir) =>
      syncPluginResources(
        targetApp,
        service,
        installDir,
        dependencies.websFacade.webappManager
      )
  };
}

