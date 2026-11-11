import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import type { DesktopActionCallResponse } from "../../../shared/desktop-actions";
import type { WebappMcpInvokeRequest, WebappMcpInvokeResult } from "../../../shared/webapp-bridge";
import { captureWebappContext, ConnectorError, request } from "./webapp-platform-client";

const active = new Set<{ app: object; appId: string }>();

// This is a WebApp data method, not a public Desktop Action. Platform owns
// destination policy, MCP transport and per-request SSO credential injection.
export async function executeWebappMcp(options: DesktopActionBridgeOptions, args: unknown,
  invocation: DesktopActionInvocationContext): Promise<DesktopActionCallResponse> {
  const action = "mcp.invoke";
  const fail = (code: string): DesktopActionCallResponse => ({ ok: false, action, error: { code, message: code } });
  if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") return fail("forbidden");
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("invalid_arguments");
  const input = args as Partial<WebappMcpInvokeRequest> & Record<string, unknown>;
  if (Object.keys(input).some(key => !["url", "toolName", "arguments", "auth"].includes(key)) ||
      typeof input.url !== "string" || !input.url.trim() || input.url.length > 8192 ||
      typeof input.toolName !== "string" || !input.toolName.trim() || input.toolName.length > 256 ||
      !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments) ||
      (input.auth !== undefined && input.auth !== "sso" && input.auth !== "none")) return fail("invalid_arguments");
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 256 * 1024) return fail("invalid_arguments");
  } catch { return fail("invalid_arguments"); }
  if (active.size >= 8 || [...active].filter(item => item.app === options.app && item.appId === invocation.webappId).length >= 2) return fail("app_capacity_exceeded");
  const entry = { app: options.app, appId: invocation.webappId };
  active.add(entry);
  const timeout = AbortSignal.timeout(35_000);
  const signal = AbortSignal.any([timeout, ...[invocation.signal, invocation.requestSignal].filter((value): value is AbortSignal => Boolean(value))]);
  try {
    signal.throwIfAborted();
    const context = await captureWebappContext(options, invocation.webappId, invocation.signal);
    await context.check();
    signal.throwIfAborted();
    const result = await request(context.baseUrl, context.token, "/api/mcp/invoke", "POST", input, false, signal);
    signal.throwIfAborted();
    await context.check();
    signal.throwIfAborted();
    if (!result?.mcp || typeof result.mcp !== "object" || Array.isArray(result.mcp)) throw new ConnectorError("invalid_platform_response");
    // Return only the tool result; host credentials never enter the DTO.
    const projected: WebappMcpInvokeResult = { mcp: result.mcp };
    return { ok: true, action, result: projected };
  } catch (error) {
    if (invocation.signal?.aborted) return fail("app_grant_required");
    if (invocation.requestSignal?.aborted) return fail("cancelled");
    if (timeout.aborted) return fail("mcp_timeout");
    return fail(error instanceof ConnectorError && error.code !== "connector_unavailable" ? error.code : "mcp_unavailable");
  } finally { active.delete(entry); }
}
