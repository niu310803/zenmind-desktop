import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { takeStartupSyncCommandTiming } from "../../infrastructure/process/startup-sync-command";
import { writePerformanceEvent } from "./performance";

type StartupTimingValue = string | number | boolean | null | undefined;

type StartupTimingMetadata = Record<string, StartupTimingValue>;

type StartupTimingEvent = {
  phase: string;
  metadata: StartupTimingMetadata;
  durationMs: number;
  startedAt: string;
  endedAt: string;
};

type StartupTimingOptions = {
  log?: boolean;
};

const startupTimingEvents: StartupTimingEvent[] = [];
const startupSnapshotEvents: StartupTimingEvent[] = [];
const MAX_TIMING_EVENTS = 512;
const BUILTIN_SERVICE_IDS = new Set(["identity-center", "agent-platform", "agent-webclient", "agent-container-hub"]);
const processStartedAtMs = Math.round(Date.now() - process.uptime() * 1000);
type StartupMilestone =
  | "main-window-ready-to-show"
  | "main-window-visible"
  | "renderer-first-contentful-paint"
  | "main-chat-document-loaded"
  | "core-ready"
  | "startup-degraded";
const startupMilestones = new Map<StartupMilestone, number>();
const rendererMilestones = new Map<StartupMilestone, number>();
let startupFinished = false;
let droppedSnapshotEvents = 0;
let snapshotPath: string | undefined;
let snapshotPending = false;
let snapshotWrite: Promise<void> | undefined;
let startupLoop: ReturnType<typeof monitorEventLoopDelay> | undefined;
let eventLoopDelay: { maxMs: number; p99Ms: number } | null = null;
const BAR_WIDTH = 32;
const SUMMARY_AGGREGATED_PHASES = new Set(["containerEngineAvailable"]);

function snapshotEvent(event: StartupTimingEvent): StartupTimingEvent {
  const metadata: StartupTimingMetadata = {};
  for (const [key, value] of Object.entries(event.metadata)) {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) metadata[key] = value;
    if (key === "serviceId" && typeof value === "string" && BUILTIN_SERVICE_IDS.has(value)) metadata[key] = value;
    if (event.phase === "startup.sync-command" && (key === "command" || key === "callSite")) metadata[key] = value;
  }
  return { ...event, metadata };
}

async function writeStartupTimingSnapshot(filename: string) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const snapshot = {
    schemaVersion: 1,
    pid: process.pid,
    platform: process.platform,
    processStartedAtMs,
    capturedAtMs: Date.now(),
    startupFinished,
    droppedEvents: droppedSnapshotEvents,
    eventLoopDelay,
    measuredSyncCommandCount: startupSnapshotEvents.filter((event) => event.phase === "startup.sync-command").length,
    milestones: Object.fromEntries(startupMilestones),
    rendererMilestones: Object.fromEntries(rendererMilestones),
    events: startupSnapshotEvents
  };
  try {
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filename);
  } catch {
    console.warn("[startup-timing] unable to write startup-timing.json");
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function scheduleStartupTimingSnapshot() {
  snapshotPending = true;
  if (!snapshotPath || snapshotWrite) return;
  const filename = snapshotPath;
  snapshotPending = false;
  snapshotWrite = writeStartupTimingSnapshot(filename).finally(() => {
    snapshotWrite = undefined;
    if (snapshotPending) scheduleStartupTimingSnapshot();
  });
}

export function configureStartupTimingOutput(logRoot: string) {
  const syncCommand = takeStartupSyncCommandTiming();
  if (syncCommand) {
    const { command, callSite, durationMs, startedAt, endedAt } = syncCommand;
    recordStartupTiming("startup.sync-command", { command, callSite }, durationMs, startedAt, endedAt);
  }
  snapshotPath = path.join(logRoot, "startup-timing.json");
  scheduleStartupTimingSnapshot();
}

export function persistStartupTimingSnapshot() {
  if (startupLoop) {
    startupLoop.disable();
    if (startupLoop.count > 0) {
      eventLoopDelay = { maxMs: startupLoop.max / 1e6, p99Ms: startupLoop.percentile(99) / 1e6 };
    }
    startupLoop = undefined;
  }
  startupFinished = true;
  scheduleStartupTimingSnapshot();
}

export function startStartupLoopTiming() {
  if (startupLoop || startupFinished) return;
  startupLoop = monitorEventLoopDelay({ resolution: 20 });
  startupLoop.enable();
}

export function markStartupMilestone(stage: StartupMilestone, rendererElapsedMs?: number) {
  if (startupMilestones.has(stage)) return;
  const processElapsedMs = Math.round(process.uptime() * 1000);
  startupMilestones.set(stage, processElapsedMs);
  if (rendererElapsedMs !== undefined) rendererMilestones.set(stage, rendererElapsedMs);
  writePerformanceEvent({ stage, processElapsedMs, hostMonoMs: rendererElapsedMs });
  scheduleStartupTimingSnapshot();
}

function nowIso() {
  return new Date().toISOString();
}

function formatDurationMs(durationMs: number) {
  return `${Math.max(0, Math.round(durationMs))}ms`;
}

function formatMetadata(metadata: StartupTimingMetadata = {}) {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/gu, "_")}`)
    .join(" ");
}

function formatStartupTimingLine(event: StartupTimingEvent, maxDurationMs: number) {
  const metadata = formatMetadata(event.metadata);
  const label = metadata ? `${event.phase} ${metadata}` : event.phase;
  const width = maxDurationMs > 0
    ? Math.max(1, Math.round((event.durationMs / maxDurationMs) * BAR_WIDTH))
    : 1;
  return `[startup-timing] ${label.padEnd(56)} ${formatDurationMs(event.durationMs).padStart(8)} ${"#".repeat(width)}`;
}

function compactStartupTimingEvents(events: StartupTimingEvent[]) {
  const compacted: StartupTimingEvent[] = [];
  const aggregateIndexes = new Map<string, number>();

  for (const event of events) {
    if (!SUMMARY_AGGREGATED_PHASES.has(event.phase)) {
      compacted.push(event);
      continue;
    }

    const key = `${event.phase}:${formatMetadata(event.metadata)}`;
    const existingIndex = aggregateIndexes.get(key);
    if (existingIndex === undefined) {
      aggregateIndexes.set(key, compacted.length);
      compacted.push({
        ...event,
        metadata: {
          ...event.metadata,
          count: 1,
          avgMs: event.durationMs,
          maxMs: event.durationMs
        }
      });
      continue;
    }

    const aggregate = compacted[existingIndex];
    const count = Number(aggregate.metadata.count ?? 1) + 1;
    const durationMs = aggregate.durationMs + event.durationMs;
    const maxMs = Math.max(Number(aggregate.metadata.maxMs ?? 0), event.durationMs);
    compacted[existingIndex] = {
      ...aggregate,
      durationMs,
      endedAt: event.endedAt,
      metadata: {
        ...aggregate.metadata,
        count,
        avgMs: Math.round(durationMs / count),
        maxMs
      }
    };
  }

  return compacted;
}

function cloneStartupTimingEvents() {
  return startupTimingEvents.map((event) => ({
    ...event,
    metadata: { ...event.metadata }
  }));
}

export function recordStartupTiming(
  phase: string,
  metadata: StartupTimingMetadata,
  durationMs: number,
  startedAt: string,
  endedAt: string,
  options: StartupTimingOptions = {}
) {
  const event = {
    phase,
    metadata: { ...metadata },
    durationMs: Math.max(0, Math.round(durationMs)),
    startedAt,
    endedAt
  };
  if (startupTimingEvents.length === MAX_TIMING_EVENTS) startupTimingEvents.shift();
  startupTimingEvents.push(event);
  if (!startupFinished) {
    if (startupSnapshotEvents.length < MAX_TIMING_EVENTS) {
      startupSnapshotEvents.push(snapshotEvent(event));
    } else {
      droppedSnapshotEvents++;
    }
  }
  if (options.log !== false) {
    const metadataText = formatMetadata(event.metadata);
    console.info(
      `[startup-timing] ${event.phase}${metadataText ? ` ${metadataText}` : ""} duration=${formatDurationMs(event.durationMs)}`
    );
  }
  return event;
}

export function beginStartupTiming(
  phase: string,
  metadata: StartupTimingMetadata = {},
  options: StartupTimingOptions = {}
) {
  const startedAtMs = performance.now();
  const startedAt = nowIso();
  let finished = false;

  return {
    end(extraMetadata: StartupTimingMetadata = {}) {
      if (finished) {
        return null;
      }
      finished = true;
      return recordStartupTiming(
        phase,
        { ...metadata, ...extraMetadata },
        performance.now() - startedAtMs,
        startedAt,
        nowIso(),
        options
      );
    }
  };
}

export function formatStartupTimingSummary(events: StartupTimingEvent[] = cloneStartupTimingEvents()) {
  if (events.length === 0) {
    return ["[startup-timing] summary total=0ms count=0"];
  }

  const firstStartedAt = Math.min(...events.map((event) => Date.parse(event.startedAt)));
  const lastEndedAt = Math.max(...events.map((event) => Date.parse(event.endedAt)));
  const totalMs = Number.isFinite(firstStartedAt) && Number.isFinite(lastEndedAt)
    ? Math.max(0, lastEndedAt - firstStartedAt)
    : events.reduce((sum, event) => sum + event.durationMs, 0);
  const maxDurationMs = Math.max(...events.map((event) => event.durationMs), 0);
  const summaryEvents = compactStartupTimingEvents(events);
  return [
    `[startup-timing] summary total=${formatDurationMs(totalMs)} count=${events.length}`,
    ...summaryEvents.map((event) => formatStartupTimingLine(event, maxDurationMs))
  ];
}

export function flushStartupTimingSummary() {
  const lines = formatStartupTimingSummary();
  for (const line of lines) {
    console.info(line);
  }
  startupTimingEvents.length = 0;
  return lines;
}

export const __testInternals = {
  formatStartupTimingSummary,
  formatMetadata,
  compactStartupTimingEvents,
  recordStartupTiming,
  beginStartupTiming,
  flushStartupTimingSummary,
  async waitForStartupTimingSnapshot() {
    while (snapshotWrite) await snapshotWrite;
  },
  clearStartupTimingEvents() {
    startupTimingEvents.length = 0;
  }
};
