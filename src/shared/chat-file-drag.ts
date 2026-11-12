export type ChatFileDragRequest = { gestureId: string; chatId: string };
export type ChatFileDragResult = { ok: boolean; message?: string };

export function isChatFileDragRequest(value: unknown): value is ChatFileDragRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as ChatFileDragRequest;
  return typeof request.gestureId === "string" && /^[a-f0-9-]{36}$/u.test(request.gestureId) &&
    typeof request.chatId === "string" && request.chatId.trim().length > 0 && request.chatId.length <= 256;
}
