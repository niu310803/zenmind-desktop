import { useEffect, useState } from "react";
import { useDebugMode } from "../debug/DebugModeContext";
import {
  buildWebviewDebugClipboardText,
  formatWebviewDebugSurfaceLabel,
} from "../debug/webviewDebugUrl";
import type { SurfaceIdentity } from "../../shared/surface-identity";
import { useI18n } from "../i18n/useI18n";

type CopyState = "idle" | "copied" | "failed";

export function WebviewDebugOverlay({
  url,
  surfaceIdentity,
  dismissKey,
}: {
  url: string;
  surfaceIdentity?: SurfaceIdentity;
  /** Host route identity; guest presentation URL changes do not reopen this overlay. */
  dismissKey?: string;
}) {
  const debugMode = useDebugMode();
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [dismissed, setDismissed] = useState(false);
  const pageKey = dismissKey ?? url;
  const displayUrl = url;
  const displaySurfaceLabel = formatWebviewDebugSurfaceLabel(surfaceIdentity);
  const copyText = buildWebviewDebugClipboardText(url, surfaceIdentity);

  useEffect(() => {
    setDismissed(false);
  }, [pageKey, debugMode]);

  useEffect(() => {
    setCopyState("idle");
  }, [copyText]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopyAll() {
    try {
      const result = await window.electronAPI.clipboard.writeText(copyText);
      setCopyState(result.ok ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  }

  const copyLabel = copyState === "copied"
    ? t("settings.debug.webviewOverlay.copied")
    : copyState === "failed"
      ? t("settings.debug.webviewOverlay.copyFailed")
      : t("settings.debug.webviewOverlay.copyAll");

  if (!debugMode || dismissed || (!displayUrl && !displaySurfaceLabel)) {
    return null;
  }

  return (
    <div className="webview-debug-url-overlay">
      <button type="button" className="webview-debug-dismiss-button"
        aria-label={t("settings.debug.webviewOverlay.dismiss")}
        title={t("settings.debug.webviewOverlay.dismiss")}
        onClick={() => setDismissed(true)}>×</button>
      {displaySurfaceLabel ? (
        <div className="webview-debug-surface-id">
          {displaySurfaceLabel}
        </div>
      ) : null}
      {displayUrl ? <div className="webview-debug-url-value">{displayUrl}</div> : null}
      {copyText ? (
        <button
          aria-live="polite"
          className={`webview-debug-copy-button is-${copyState}`}
          onClick={() => void handleCopyAll()}
          title={copyLabel}
          type="button"
        >
          {copyLabel}
        </button>
      ) : null}
    </div>
  );
}
