import type { AssistantChatInfo, AssistantChatInfoRun } from "./contracts/copilot";
import type { TranslateFunction } from "./i18n/types";

export type ChatInfoSummary = {
  chatId: string;
  chatName: string;
  agentKey: string;
};

export type ChatInfoRow = {
  key: string;
  label: string;
  displayValue: string;
  copyValue: string;
};

function createChatInfoRow(
  key: string,
  label: string,
  value: unknown,
  options: { displayValue?: string; copyValue?: string } = {},
): ChatInfoRow | null {
  const copyValue = options.copyValue ?? String(value ?? "");
  if (!copyValue.trim()) return null;
  return {
    key,
    label,
    displayValue: options.displayValue ?? copyValue,
    copyValue,
  };
}

export function formatTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** 会话信息的创建/更新时间按本地时区展示为 YYYY-MM-DD HH:mm:ss。 */
export function formatChatInfoDateTime(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function buildChatInfoRows(input: {
  summary: ChatInfoSummary;
  detail: AssistantChatInfo | null;
  t: TranslateFunction;
}): ChatInfoRow[] {
  const { summary, detail, t } = input;
  const createdAt = detail?.createdAt;
  const updatedAt = detail?.updatedAt;
  return [
    createChatInfoRow("chatId", t("sidebar.chat.infoField.chatId"), detail?.chatId || summary.chatId),
    createChatInfoRow("chatName", t("sidebar.chat.infoField.chatName"), detail?.chatName || summary.chatName),
    createChatInfoRow("agentKey", t("sidebar.chat.infoField.agentKey"), detail?.agentKey || summary.agentKey),
    createChatInfoRow("firstAgentKey", t("sidebar.chat.infoField.firstAgentKey"), detail?.firstAgentKey),
    createChatInfoRow("firstAgentName", t("sidebar.chat.infoField.firstAgentName"), detail?.firstAgentName),
    createChatInfoRow("source", t("sidebar.chat.infoField.source"), detail?.source),
    createChatInfoRow("createdAt", t("sidebar.chat.infoField.createdAt"), createdAt, {
      displayValue: formatChatInfoDateTime(createdAt),
      copyValue: createdAt === undefined ? undefined : String(createdAt),
    }),
    createChatInfoRow("updatedAt", t("sidebar.chat.infoField.updatedAt"), updatedAt, {
      displayValue: formatChatInfoDateTime(updatedAt),
      copyValue: updatedAt === undefined ? undefined : String(updatedAt),
    }),
  ].filter((row): row is ChatInfoRow => Boolean(row));
}

export function formatChatInfoRunTiming(run: AssistantChatInfoRun, t: TranslateFunction) {
  const duration = run.startedAt !== undefined && run.completedAt !== undefined && run.completedAt >= run.startedAt
    ? `${Math.round((run.completedAt - run.startedAt) / 1000)} s`
    : "—";
  const start = formatTimestamp(run.startedAt)?.replace(/\.\d{3}Z$/u, "Z") ?? "—";
  const end = formatTimestamp(run.completedAt)?.replace(/\.\d{3}Z$/u, "Z") ?? "—";
  return `${start} → ${end} · ${t("sidebar.chat.infoRunDuration")}: ${duration}`;
}

export function buildChatInfoCopyAllText(rows: ChatInfoRow[], runs: AssistantChatInfoRun[] = [], t?: TranslateFunction) {
  return [
    ...rows.map((row) => `${row.label}: ${row.copyValue}`),
    ...runs.map((run) => `Run ID: ${run.runId}\n${t ? formatChatInfoRunTiming(run, t) : ""}`),
  ].join("\n");
}
