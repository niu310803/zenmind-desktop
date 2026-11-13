import type { RegisteredWebviewSurfaceTarget } from "../web-surfaces";
import type { ArtifactDragIdentity } from "../../../shared/contracts/agent-webclient-bridge";
import { readAgentWebclientCanonicalChatSource } from "../../../shared/canonical-chat-sync";
import { artifactRelativePath } from "./actions";

/** Main Chat and Overview own their published list; an artifact viewer owns only its bound file. */
export function artifactDragSurfaceAllowed(target: RegisteredWebviewSurfaceTarget | null, input: ArtifactDragIdentity, url: string, ownerId: number) {
  if (!target?.active || target.serviceId !== "agent-webclient" || target.ownerWebContentsId !== ownerId || target.ownerChatId !== input.chatId) return false;
  if (target.surfaceRole === "main-chat" && target.surfaceLevel === "root") {
    return target.surfaceId === "main-chat" && readAgentWebclientCanonicalChatSource(url)?.chatId === input.chatId;
  }
  if (target.surfaceLevel !== "child") return false;
  if (target.surfaceRole === "overview") {
    try { return decodeURIComponent(new URL(url).pathname) === `/overview/${input.chatId}`; } catch { return false; }
  }
  if (target.surfaceRole !== "artifact") return false;
  const source = target.documentSource;
  if (source && source.kind !== "artifact") return false;
  let relativePath: string | null = null;
  try { const route = new URL(url);
    if (route.searchParams.get("chatId") !== input.chatId) return false;
    relativePath = artifactRelativePath(route.searchParams.get("file"), input.chatId);
  } catch { /* Invalid routes fail closed. */ }
  if (source?.kind === "artifact") {
    if (source.chatId !== input.chatId) return false;
    relativePath = source.relativePath;
  }
  if (input.relativePath) return !!relativePath && input.relativePath === relativePath;
  return source?.kind === "artifact" && input.artifactId === source.resourceId;
}
