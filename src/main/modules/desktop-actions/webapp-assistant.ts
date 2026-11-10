import { selectWebappAssistantAgent } from "./webapp-assistant-agent";
import { randomUUID } from "node:crypto";
import { type AssistantStartRunRequest } from "../../../shared/contracts";
import { type DesktopActionBridgeOptions, type DesktopActionInvocationContext } from "./action-contracts";
import { captureWebappContext, ConnectorError, type WebappContext } from "./webapp-platform-client";
import { rememberWebappChat } from "./webapp-connector";

type Event = { cursor: number; type: string; text?: string; reason?: string; awaitingId?: string; mode?: string };
type Run = { context: WebappContext; chatId: string; runId: string; events: Event[]; cursor: number; terminal: boolean; agentKey: string; release(): void };
const runs = new Map<string, Run>();
const MAX_EVENTS = 256;
const MAX_RUNS = 128;
function append(run: Run, event: Omit<Event, "cursor">) {
  run.events.push({ ...event, cursor: ++run.cursor });
  if (run.events.length > MAX_EVENTS) run.events.shift();
}
export async function startWebappAssistant(options: DesktopActionBridgeOptions, context: WebappContext, request: AssistantStartRunRequest) {
  if (runs.size >= MAX_RUNS) throw new ConnectorError("app_capacity_exceeded");
  await context.check();
  const accepted = await options.assistantBridge.startRun(request);
  await context.check();
  if (!accepted.ok || !accepted.chatId || !accepted.runId) throw new ConnectorError("assistant_failed");
  rememberWebappChat(context.key, accepted.chatId);
  const run: Run = { context, chatId: accepted.chatId, runId: accepted.runId, events: [], cursor: 0, terminal: false, agentKey: request.agentKey || "", release() {} };
  runs.set(run.runId, run);
  append(run, { type: "run.accepted" });
  let detach = () => {};
  let released = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await context.check(); }
    catch { run.release(); }
    finally { checking = false; }
  }, 1000);
  timer.unref();
  const expiry = setTimeout(() => run.release(), 30 * 60_000);
  expiry.unref();
  const revoke = () => run.release();
  run.release = () => {
    released = true; runs.delete(run.runId); detach(); clearInterval(timer); clearTimeout(expiry);
    context.signal?.removeEventListener("abort", revoke);
  };
  context.signal?.addEventListener("abort", revoke, { once: true });
  try {
    const subscription = await options.assistantBridge.observeRun({
      runId: run.runId, chatId: run.chatId,
      agentKey: request.agentKey, consumerId: `webapp:${randomUUID()}`,
      onEvent(event) {
        // Never relay tool arguments/results, credentials or the raw protocol frame.
        if (released || run.terminal) return;
        if (typeof event.type !== "string") return;
        if (event.type === "content.delta") {
          const text = typeof event.text === "string" ? event.text : typeof event.delta === "string" ? event.delta : "";
          for (let offset = 0; offset < text.length; offset += 4096) append(run, { type: "text.delta", text: text.slice(offset, offset + 4096) });
        } else if (event.type === "awaiting.asking" && typeof event.awaitingId === "string") {
          append(run, { type: event.type, awaitingId: event.awaitingId, ...(typeof event.mode === "string" ? { mode: event.mode } : {}) });
        } else if (["run.start", "run.complete", "run.error", "run.interrupted", "artifact.publish", "artifact.published"].includes(event.type)) {
          append(run, { type: event.type });
        }
      },
      onComplete(result) { if (released) return; detach(); run.terminal = true; append(run, { type: "run.finished", reason: result.reason }); },
      onError() { if (released) return; detach(); run.terminal = true; append(run, { type: "run.failed", reason: "assistant_unavailable" }); }
    });
    detach = () => { subscription.unsubscribe(); };
    if (released || run.terminal) detach();
    await subscription.ready;
    await context.check();
  } catch {
    // The Agent was already accepted. Preserve its identity; never resend query.
    run.terminal = true;
    append(run, { type: "subscription.failed", reason: "assistant_unavailable" });
  }
  await context.check();
  return { chatId: run.chatId, runId: run.runId, accepted: true };
}
export async function executeWebappAssistant(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, invocation: DesktopActionInvocationContext) {
  try {
    if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") throw new ConnectorError("forbidden");
    const context = await captureWebappContext(options, invocation.webappId, invocation.signal);
    if (action === "assistant.agents.list") {
      if (Object.keys(args).length) throw new ConnectorError("invalid_arguments");
      const agents = await options.assistantBridge.listAgents();
      const defaultAgentKey = await selectWebappAssistantAgent(options, context.item);
      const items = agents.map(agent => ({ agentKey: agent.agentKey, name: agent.displayName || agent.agentKey, role: agent.role }));
      await context.check();
      return { ok: true, action, result: { items, defaultAgentKey } };
    }
    const allowed = action === "assistant.events" ? ["runId", "cursor"] : action === "assistant.steer" || action === "assistant.send" ? ["runId", "message", "requestId", "steerId"] : action === "assistant.submit" ? ["runId", "awaitingId", "submitId", "param", "params"] : ["runId"];
    if (Object.keys(args).some(key => !allowed.includes(key)) || typeof args.runId !== "string") throw new ConnectorError("invalid_arguments");
    const run = runs.get(args.runId);
    if (!run || run.context.key !== context.key) throw new ConnectorError("app_grant_required");
    await run.context.check();
    if (["assistant.steer", "assistant.send", "assistant.submit"].includes(action)) {
      if (run.terminal) throw new ConnectorError("run_finished");
      if (action !== "assistant.submit" && (typeof args.message !== "string" || !args.message.trim() || args.message.length > 12000)) throw new ConnectorError("invalid_arguments");
      if (action === "assistant.submit" && (typeof args.awaitingId !== "string" || !args.awaitingId || ("param" in args) === ("params" in args))) throw new ConnectorError("invalid_arguments");
      const { runId: _, ...input } = args;
      if (action === "assistant.send" && "steerId" in input) throw new ConnectorError("invalid_arguments");
      const result = await options.assistantBridge.controlWebappRun(action === "assistant.steer" ? "/api/steer" : action === "assistant.send" ? "/api/send" : "/api/submit", {
        ...input, ...(action === "assistant.send" ? { requestId: args.requestId || randomUUID() } : { runId: run.runId }), chatId: run.chatId, agentKey: run.agentKey
      });
      await context.check();
      return { ok: true, action, result };
    }
    if (action === "assistant.stop" || action === "assistant.interrupt") {
      const stopped = await options.assistantBridge.stopMainRun(run.runId, run.agentKey);
      await context.check();
      if (!stopped.ok) throw new ConnectorError("assistant_stop_failed");
      return { ok: true, action, result: { stopped: true } };
    }
    const cursor = args.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) > run.cursor) throw new ConnectorError("invalid_arguments");
    if (run.events.length && (cursor as number) < run.events[0].cursor - 1) throw new ConnectorError("event_cursor_expired");
    return { ok: true, action, result: { chatId: run.chatId, runId: run.runId, events: run.events.filter(event => event.cursor > (cursor as number)), cursor: run.cursor, terminal: run.terminal } };
  } catch (error) { return { ok: false, action, error: { code: error instanceof ConnectorError ? error.code : "assistant_unavailable", message: "Assistant request failed." } }; }
}
