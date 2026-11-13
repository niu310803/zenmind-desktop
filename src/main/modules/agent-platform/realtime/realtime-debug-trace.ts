import type {
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
} from "../../../../shared/contracts";
import { requireEpochMillis } from "../../../../shared/time-contract";
import type { SurfaceInteraction, SurfaceLevel, SurfaceRole } from "../../../../shared/surface-identity";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const INSPECTOR_CLOSE_GRACE_MS = 60_000;
const CONNECTION_DIAGNOSTIC_TTL_MS = 5 * 60_000;
const MAX_RECENT_CONNECTION_DIAGNOSTICS = 32;
const STREAM_PREVIEW_CHARS = 200;
const MAX_TRACE_DEPTH = 8;
const MAX_TRACE_NODES = 2_000;
const MAX_TRACE_STRING_CHARS = 64 * 1024;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const REDACTED_VALUE = "<REDACTED>";
const TRUNCATED_VALUE = "<TRUNCATED>";

type SerializeState = {
  nodes: number;
  remainingStringChars: number;
  seen: WeakSet<object>;
};

function serializeString(value: string, state: SerializeState) {
  if (state.remainingStringChars <= 0) return TRUNCATED_VALUE;
  const allowed = Math.min(value.length, state.remainingStringChars);
  state.remainingStringChars -= allowed;
  return allowed === value.length
    ? value
    : `${value.slice(0, allowed)}…<TRUNCATED ${value.length - allowed} chars>`;
}

function serializeValue(
  value: unknown,
  state: SerializeState,
  depth: number,
  browserFileTransfer = false,
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return serializeString(value, state);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "<UNDEFINED>";
  if (typeof value === "function") return "<FUNCTION>";
  if (typeof value === "symbol") return String(value);
  if (depth >= MAX_TRACE_DEPTH || state.nodes >= MAX_TRACE_NODES) return TRUNCATED_VALUE;
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) return "<CIRCULAR>";

  state.nodes += 1;
  state.seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength} bytes>`;
    if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`;
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => serializeValue(item, state, depth + 1, browserFileTransfer));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`<TRUNCATED ${value.length - MAX_ARRAY_ITEMS} items>`);
      }
      return items;
    }

    const output: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const binaryChunk = record.encoding === "base64" &&
      (record.type === "desktop.bridge.response.delta" || record.type === "desktop.cdp.screenshot.delta");
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      // Only browser file bodies and the bridge's explicit binary chunks are omitted.
      // Ordinary business fields named data/chunk retain the existing diagnostic behavior.
      output[key] = browserFileTransfer && typeof item === "string" && (key === "data" || (binaryChunk && key === "chunk"))
        ? REDACTED_VALUE
        : serializeValue(item, state, depth + 1, browserFileTransfer);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      output.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

// Preserve local diagnostic values except file bodies, with bounded snapshots.
export function serializeAgentRealtimeDebugValue(value: unknown, browserFileTransfer = false) {
  const frame = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const body = frame.frame === "request" ? frame.payload : frame.data;
  const method = body && typeof body === "object" ? (body as Record<string, unknown>).method : undefined;
  browserFileTransfer ||= frame.type === "desktop.cdp.call" &&
    (method === "Surface.uploadFiles" || method === "Surface.readDownload");
  return serializeValue(value, {
    nodes: 0,
    remainingStringChars: MAX_TRACE_STRING_CHARS,
    seen: new WeakSet(),
  }, 0, browserFileTransfer);
}

type TraceInput = {
  layer: AgentRealtimeDebugTraceLayer;
  direction: AgentRealtimeDebugTraceDirection;
  data: unknown;
  /** Private sender metadata for file response chunks without a method field. */
  browserFileTransfer?: boolean;
  wireBytes?: number;
  surfaceId?: string;
  webContentsId?: number;
  surfaceKind?: string;
  surfaceRole?: SurfaceRole;
  surfaceLevel?: SurfaceLevel;
  parentSurfaceId?: string;
  interaction?: SurfaceInteraction;
  route?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function summarizeStream(frame: Record<string, unknown>, input: TraceInput) {
  const event = asRecord(frame.event);
  const text = event && !input.browserFileTransfer
    ? [event.delta, event.text, event.content, event.message, event.chunk].find((value): value is string => typeof value === "string")
    : undefined;
  const prefix = text?.slice(0, STREAM_PREVIEW_CHARS);
  const preview = prefix !== undefined && text !== undefined && prefix.length < text.length
    ? prefix.replace(/[\uD800-\uDBFF]$/u, "")
    : prefix;
  return {
    frame: "stream",
    ...(typeof frame.lane === "string" ? { lane: frame.lane } : {}),
    ...(typeof frame.id === "string" ? { id: frame.id } : {}),
    ...(typeof frame.streamId === "string" ? { streamId: frame.streamId } : {}),
    ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
    ...(typeof frame.lastSeq === "number" ? { lastSeq: frame.lastSeq } : {}),
    ...(input.wireBytes !== undefined ? { wireBytes: input.wireBytes } : {}),
    ...(event ? {
      event: {
        ...(typeof event.type === "string" ? { type: event.type } : {}),
        ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        ...(typeof event.runId === "string" ? { runId: event.runId } : {}),
        ...(typeof event.chatId === "string" ? { chatId: event.chatId } : {}),
        ...(typeof event.timestamp === "number" ? { timestamp: event.timestamp } : {}),
        ...(input.browserFileTransfer ? { preview: REDACTED_VALUE } : {}),
        ...(preview !== undefined && text !== undefined ? {
          preview,
          ...(!input.wireBytes ? { textBytes: Buffer.byteLength(text) } : {}),
          ...(preview.length < text.length ? { previewTruncated: true } : {}),
        } : {}),
      },
    } : {}),
  };
}

function serializeTraceData(input: TraceInput) {
  const record = asRecord(input.data);
  const isPortEvent = record?.type === "frame" && typeof record.sessionId === "string";
  const frame = isPortEvent ? asRecord(record?.frame) : record;
  const summary = frame?.frame === "stream" ? summarizeStream(frame, input) : frame?.frame === "push" ? {
    frame: "push",
    ...(typeof frame.lane === "string" ? { lane: frame.lane } : {}),
    ...(typeof frame.type === "string" ? { type: frame.type } : {}),
    ...(input.wireBytes !== undefined ? { wireBytes: input.wireBytes } : {}),
  } : null;
  if (summary) {
    return serializeAgentRealtimeDebugValue(isPortEvent
      ? { type: "frame", sessionId: record?.sessionId, frame: summary }
      : summary);
  }
  return serializeAgentRealtimeDebugValue(input.data, input.browserFileTransfer);
}

export class RealtimeDebugTraceBuffer {
  private readonly entries: Array<{ entry: AgentRealtimeDebugTraceEntry; bytes: number }> = [];
  private readonly connectionDiagnostics: AgentRealtimeDebugTraceEntry[] = [];
  private bytes = 0;
  private sequence = 0;
  private inspectorOpen = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly options: {
    alwaysEnabled?: boolean;
    maxEntries?: number;
    maxBytes?: number;
  } = {}) {}

  isEnabled() {
    return !this.disposed && (this.options.alwaysEnabled === true || this.inspectorOpen || this.closeTimer !== undefined);
  }

  setInspectorOpen(open: boolean) {
    if (this.disposed || this.inspectorOpen === open) return;
    this.inspectorOpen = open;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    if (!open && !this.options.alwaysEnabled) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = undefined;
        this.clearFrames();
      }, INSPECTOR_CLOSE_GRACE_MS);
      this.closeTimer.unref?.();
    }
  }

  append(trace: TraceInput): AgentRealtimeDebugTraceEntry | undefined {
    if (!this.isEnabled()) return;
    const entry: AgentRealtimeDebugTraceEntry = {
      sequence: ++this.sequence,
      recordedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugTrace.recordedAt"),
      layer: trace.layer,
      direction: trace.direction,
      data: serializeTraceData(trace),
      ...(trace.surfaceId?.trim() ? { surfaceId: trace.surfaceId.trim() } : {}),
      ...(Number.isSafeInteger(trace.webContentsId) ? { webContentsId: trace.webContentsId } : {}),
      ...(trace.surfaceKind?.trim() ? { surfaceKind: trace.surfaceKind.trim() } : {}),
      ...(trace.surfaceRole ? { surfaceRole: trace.surfaceRole } : {}),
      ...(trace.surfaceLevel ? { surfaceLevel: trace.surfaceLevel } : {}),
      ...(trace.parentSurfaceId?.trim() ? { parentSurfaceId: trace.parentSurfaceId.trim() } : {}),
      ...(trace.interaction ? { interaction: trace.interaction } : {}),
      ...(trace.route?.trim() ? { route: trace.route.slice(0, MAX_TRACE_STRING_CHARS) } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxEntries = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (bytes > maxBytes) return;
    this.entries.push({ entry, bytes });
    this.bytes += bytes;
    while (this.entries.length > maxEntries || this.bytes > maxBytes) {
      const oldest = this.entries.shift();
      if (!oldest) break;
      this.bytes -= oldest.bytes;
    }
    return entry;
  }

  recordConnectionFailure(
    lane: "primary" | "btw" | "selection-explain",
    phase: "reconnecting" | "error",
    generation: number,
    reconnectCount: number,
  ) {
    if (this.disposed) return;
    const entry: AgentRealtimeDebugTraceEntry = {
      sequence: ++this.sequence,
      recordedAt: requireEpochMillis(Date.now(), "agentRealtimeDebugTrace.recordedAt"),
      layer: "platform-ws",
      direction: "platform-to-desktop",
      data: { lane, type: "connection", phase, generation, reconnectCount },
    };
    // Only lifecycle metadata is retained before the Inspector opens.
    this.connectionDiagnostics.push(entry);
    if (this.connectionDiagnostics.length > MAX_RECENT_CONNECTION_DIAGNOSTICS) {
      this.connectionDiagnostics.shift();
    }
  }

  snapshot(afterSequence = 0) {
    const cutoff = Date.now() - CONNECTION_DIAGNOSTIC_TTL_MS;
    const events = this.entries.flatMap(({ entry }) => entry.sequence > afterSequence ? [{ ...entry }] : []);
    for (const entry of this.connectionDiagnostics) {
      if (entry.sequence > afterSequence && entry.recordedAt >= cutoff) events.push({ ...entry });
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  clear() {
    this.clearFrames();
    this.connectionDiagnostics.length = 0;
  }

  private clearFrames() {
    this.entries.length = 0;
    this.bytes = 0;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.clear();
  }
}
