import { useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/useI18n";
import { SettingsActionButton } from "./SettingsActionButton";

export function DebugFactValue({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const textRef = useRef<HTMLSpanElement>(null);
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    const text = textRef.current?.textContent ?? "";
    if (!text) return;
    try {
      await window.electronAPI.clipboard.writeText(text);
      setFeedback("copied");
    } catch {
      setFeedback("failed");
    }
  }

  return <dd className="settings-debug-copy-value" onMouseLeave={() => setFeedback("idle")}>
    <span ref={textRef}>{children}</span>
    <SettingsActionButton icon="copy" label={t(feedback === "copied" ? "settings.debug.webviewOverlay.copied" : feedback === "failed" ? "settings.debug.webviewOverlay.copyFailed" : "common.copy")} onClick={() => void copy()} />
  </dd>;
}
