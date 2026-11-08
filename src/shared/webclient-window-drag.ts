// Internal isolated-preload/host protocol; deliberately not exposed to page JS.
export const WEBCLIENT_WINDOW_DRAG_CHANNEL = "desktop:service-webview:window-drag";
export const WEBCLIENT_WINDOW_DRAG_HEIGHT = 40;
export type WebclientWindowDragAction = "ready" | "begin" | "end" | "maximize";
export function parseWebclientWindowDragMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 4 || data.version !== "1.0" ||
    typeof data.documentId !== "string" || !/^[a-f\d-]{36}$/i.test(data.documentId) ||
    typeof data.origin !== "string" ||
    !["ready", "begin", "end", "maximize"].includes(String(data.action))) return null;
  return data as { version: "1.0"; documentId: string; origin: string; action: WebclientWindowDragAction };
}
