import type { WorkPanelDocumentSource, WorkPanelWebclientDescriptor } from "./contracts/agent-webclient-bridge";

import { AGENT_WEBCLIENT_HTML_DRAFT_MAX_BYTES, AGENT_WEBCLIENT_HTML_DRAFT_MAX_NAME_CHARS } from "./contracts/agent-webclient-bridge";

export function isHtmlDraftName(value: unknown): value is string {
  return typeof value === "string" && value.length <= AGENT_WEBCLIENT_HTML_DRAFT_MAX_NAME_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html|htm)$/u.test(value) && !value.includes("..");
}

const text = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 2_048 &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : "";

export function normalizeWorkPanelDocumentSource(value: unknown): WorkPanelDocumentSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const agentKey = text(source.agentKey);
  if (!agentKey) return null;
  if (source.kind === "html-draft") {
    if (Object.keys(source).some((key) => !["kind", "agentKey", "chatId", "name", "sha256", "html"].includes(key))) return null;
    const chatId = text(source.chatId);
    if (!chatId || !isHtmlDraftName(source.name) || typeof source.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(source.sha256) || typeof source.html !== "string" ||
        !source.html.trim() || source.html.includes("\0") || source.html.length > AGENT_WEBCLIENT_HTML_DRAFT_MAX_BYTES ||
        new TextEncoder().encode(source.html).byteLength > AGENT_WEBCLIENT_HTML_DRAFT_MAX_BYTES) return null;
    return { kind: "html-draft", agentKey, chatId, name: source.name, sha256: source.sha256, html: source.html };
  }
  if (source.kind === "workspace-file") {
    if (Object.keys(source).some((key) => !["kind", "agentKey", "path"].includes(key))) return null;
    const path = text(source.path).replace(/\\/gu, "/");
    return path ? { kind: "workspace-file", agentKey, path } : null;
  }
  if (source.kind !== "artifact" && source.kind !== "reference") return null;
  if (Object.keys(source).some((key) => !["kind", "agentKey", "chatId", "resourceId", "relativePath"].includes(key))) return null;
  const chatId = text(source.chatId);
  const resourceId = text(source.resourceId);
  const relativePath = text(source.relativePath).replace(/\\/gu, "/");
  return chatId && resourceId && relativePath
    ? { kind: source.kind, agentKey, chatId, resourceId, relativePath }
    : null;
}

export function sameWorkPanelDocumentSource(left: unknown, right: unknown) {
  const normalizedLeft = normalizeWorkPanelDocumentSource(left);
  const normalizedRight = normalizeWorkPanelDocumentSource(right);
  return Boolean(normalizedLeft && normalizedRight && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight));
}

/** Only the host-owned item descriptor can grant a document guest local-open access. */
export function documentSourceFromWebclientDescriptor(descriptor: WorkPanelWebclientDescriptor): WorkPanelDocumentSource | undefined {
  if (descriptor.module === "file") {
    return normalizeWorkPanelDocumentSource({ kind: "workspace-file", ...descriptor.context }) ?? undefined;
  }
  if (descriptor.module === "artifact" || descriptor.module === "reference") {
    const context = descriptor.context;
    return normalizeWorkPanelDocumentSource({
      kind: descriptor.module,
      agentKey: context.agentKey,
      chatId: context.chatId,
      resourceId: "artifactId" in context ? context.artifactId : context.referenceId,
      relativePath: context.relativePath,
    }) ?? undefined;
  }
  return undefined;
}
