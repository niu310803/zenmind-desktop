import { WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS } from "./webapp-manifest";

export const WEBAPP_EXECUTE_TIMEOUT_MS = 600_000;
export const WEBAPP_EXECUTE_TRANSPORT_TIMEOUT_MS = 615_000;
export const WEBAPP_EXECUTE_RESPONSE_BYTES = 1024 * 1024;
export type WebappExecuteResult =
  | { chatId: string; status: "success"; output: Record<string, unknown> }
  | { chatId: string; status: "failure"; reason: string };
// Matches Platform's JSON Reference contract; resource authorization remains with Platform.
export type WebappExecuteReference = {
  annotationIndex?: number; id?: string; type?: string; text?: string; annotation?: string;
  name?: string; path?: string; mimeType?: string; sizeBytes?: number; url?: string;
  sha256?: string; meta?: Record<string, unknown>;
};
export type WebappExecuteInput = {
  message: string; outputSchema: Record<string, unknown>; input?: unknown; agentKey?: string;
  chatId?: string; references?: WebappExecuteReference[];
};

export function isExecuteRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validateWebappExecute(value: unknown): string | null {
  if (!isExecuteRecord(value) || Object.keys(value).some(key => !["message", "input", "outputSchema", "agentKey", "chatId", "references"].includes(key))) return "invalid_args";
  if (value.agentKey !== undefined && (typeof value.agentKey !== "string" || !value.agentKey.trim() || value.agentKey.length > 256)) return "invalid_args";
  if (value.chatId !== undefined && (typeof value.chatId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.chatId))) return "invalid_args";
  if (value.references !== undefined && (!Array.isArray(value.references) || !value.references.every(ref => {
    if (!isExecuteRecord(ref)) return false;
    return Object.entries(ref).every(([key, item]) => {
      if (["annotationIndex", "sizeBytes"].includes(key)) return Number.isSafeInteger(item);
      if (key === "meta") return isExecuteRecord(item);
      return ["id", "type", "text", "annotation", "name", "path", "mimeType", "url", "sha256"].includes(key) && typeof item === "string";
    });
  }))) return "invalid_args";
  if (typeof value.message !== "string" || !value.message.trim()) return "invalid_args";
  if (value.message.length > WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS) return "assistant_message_too_long";
  const schema = value.outputSchema;
  if (!isExecuteRecord(schema) || schema.type !== "object") return "invalid_args";
  // Bound recursion too: a small hostile JSON body can otherwise overflow Main's stack.
  function json(node: unknown, depth: number, input: boolean): boolean {
    if (depth > 64) return false;
    if (node === null || typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (Array.isArray(node)) return node.every(item => json(item, depth + 1, input));
    return isExecuteRecord(node) && !Object.getOwnPropertySymbols(node).length &&
      Object.entries(node).every(([key, item]) => (!input || key !== "$file") && json(item, depth + 1, input));
  }
  if (!json(schema, 0, false) || (value.input !== undefined && !json(value.input, 0, true)) ||
      (value.references !== undefined && !json(value.references, 0, false))) return "invalid_args";
  return new TextEncoder().encode(JSON.stringify(schema)).length > 64 * 1024 ? "invalid_args" : null;
}
