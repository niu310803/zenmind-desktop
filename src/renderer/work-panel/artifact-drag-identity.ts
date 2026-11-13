import type { ArtifactDragIdentity, WorkPanelItemDescriptor } from "../../shared/contracts/agent-webclient-bridge";
export function workPanelArtifactDragIdentity(chatId: string, descriptor: WorkPanelItemDescriptor): ArtifactDragIdentity | null {
  let relativePath = "";
  if (descriptor.kind === "native" && ["resource-image", "document-image", "document-html"].includes(descriptor.surfaceKey)) {
    const context = descriptor.context;
    if (descriptor.surfaceKey === "document-html" && context.sourceKind === "artifact" && typeof context.displayUrl === "string") {
      relativePath = context.displayUrl.replace(/^@chat\//iu, "");
    }
    if (context.profile === "artifact" && context.chatId === chatId && typeof context.relativePath === "string") relativePath = context.relativePath;
  } else if (descriptor.kind === "webclient" && descriptor.module === "artifact" && descriptor.context.chatId === chatId) {
    relativePath = descriptor.context.relativePath || "";
    if (!relativePath) {
      try { const file = new URL(descriptor.route, "http://desktop.local").searchParams.get("file") || "";
        relativePath = /^@chat\//iu.test(file) ? file.slice(6) : file.split("/").map(decodeURIComponent).join("/");
      } catch { return null; }
    }
  }
  return relativePath.startsWith("artifacts/") ? { chatId, relativePath } : null;
}
