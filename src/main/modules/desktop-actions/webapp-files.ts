import { randomUUID } from "node:crypto";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./action-contracts";
import { captureWebappContext, ConnectorError, request, type WebappContext } from "./webapp-platform-client";
import { assertWebappChat, prepareWebappChat, rememberWebappChat } from "./webapp-connector";
import { selectWebappAssistantAgent } from "./webapp-assistant-agent";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
type FileReference = { type: "file"; id: string; name: string; url: string; mimeType: string; sizeBytes: number };
const uploads = new Map<string, { key: string; chatId: string; reference: FileReference; expires: number }>();
export function resolveWebappUploads(context: WebappContext, chatId: string, ids: unknown): FileReference[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 16) throw new ConnectorError("invalid_arguments");
  return ids.map(id => {
    const item = uploads.get(id);
    if (!item || item.key !== context.key || item.chatId !== chatId || item.expires < Date.now()) throw new ConnectorError("app_grant_required");
    return item.reference;
  });
}
export async function executeWebappFiles(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, invocation: DesktopActionInvocationContext) {
  try {
    if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") throw new ConnectorError("forbidden");
    const context = await captureWebappContext(options, invocation.webappId, invocation.signal);
    if (action === "assistant.resource.read") {
      if (Object.keys(args).some(key => !["chatId", "file"].includes(key))) throw new ConnectorError("invalid_arguments");
      assertWebappChat(context.key, args.chatId);
      // A Chat-relative POSIX path is identical on Windows and macOS. Never accept host paths or URLs.
      if (typeof args.file !== "string" || !args.file || args.file.length > 4096 || /[\\:\x00-\x1f\x7f?#]/u.test(args.file) || args.file.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) throw new ConnectorError("invalid_arguments");
      const result = await request(context.baseUrl, context.token, `/api/resource?${new URLSearchParams({ file: `${args.chatId}/${args.file}` })}`, "GET", undefined, true, context.signal, MAX_RESOURCE_BYTES);
      await context.check();
      return { ok: true, action, result };
    }
    if (Object.keys(args).some(key => !["chatId", "name", "mimeType", "dataBase64", "agentKey"].includes(key)) || typeof args.name !== "string" || !args.name || args.name.length > 255 || /[\\/\x00-\x1f\x7f]/u.test(args.name) || [".", ".."].includes(args.name) || typeof args.dataBase64 !== "string" || args.dataBase64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) throw new ConnectorError("invalid_arguments");
    if (args.mimeType !== undefined && (typeof args.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/u.test(args.mimeType))) throw new ConnectorError("invalid_arguments");
    if (args.chatId !== undefined) assertWebappChat(context.key, args.chatId);
    for (const [id, item] of uploads) if (item.expires < Date.now()) uploads.delete(id);
    if (uploads.size >= 1024) throw new ConnectorError("app_capacity_exceeded");
    const bytes = Buffer.from(args.dataBase64, "base64");
    if (bytes.toString("base64") !== args.dataBase64) throw new ConnectorError("invalid_arguments");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new ConnectorError("upload_too_large");
    const release = prepareWebappChat(context.key);
    try {
      const form = new FormData();
      // Platform creates the canonical Chat when the caller has no existing one.
      if (typeof args.chatId === "string") form.set("chatId", args.chatId);
      form.set("requestId", randomUUID());
      form.set("agentKey", await selectWebappAssistantAgent(options, context.item, args.agentKey));
      form.set("file", new Blob([bytes], { type: args.mimeType as string || "application/octet-stream" }), args.name);
      await context.check();
      const result = await request(context.baseUrl, context.token, "/api/upload", "POST", form, false, context.signal);
      await context.check();
      const upload = result?.upload;
      const chatId = result?.chatId;
      if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(chatId) || (args.chatId !== undefined && chatId !== args.chatId) || typeof upload?.id !== "string" || typeof upload.name !== "string" || upload.url !== `@chat/${upload.name}` || !Number.isSafeInteger(upload.sizeBytes)) throw new ConnectorError("invalid_platform_response");
      rememberWebappChat(context.key, chatId);
      const reference: FileReference = { type: "file", id: upload.id, name: upload.name, url: upload.url, mimeType: typeof upload.mimeType === "string" ? upload.mimeType : "application/octet-stream", sizeBytes: upload.sizeBytes };
      uploads.set(upload.id, { key: context.key, chatId, reference, expires: Date.now() + 30 * 60_000 });
      return { ok: true, action, result: { chatId, upload: reference } };
    } finally { release(); }
  } catch (error) {
    return { ok: false, action, error: { code: error instanceof ConnectorError ? error.code : "assistant_unavailable", message: "File request failed." } };
  }
}
