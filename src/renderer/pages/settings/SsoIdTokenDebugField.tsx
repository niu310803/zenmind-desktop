import { useId, useState } from "react";
import { Button, Input } from "antd";
import { useI18n } from "../../i18n/useI18n";
import { decodeJwtPayload } from "./decodeJwtPayload";

export function SsoIdTokenDebugField({ content }: { content: string }) {
  const { t } = useI18n();
  const id = useId();
  const [result, setResult] = useState<{ source: string; payload?: string; error?: boolean } | null>(null);
  const currentResult = result?.source === content ? result : null;

  function handleDecode() {
    try {
      setResult({ source: content, payload: decodeJwtPayload(content) });
    } catch {
      setResult({ source: content, error: true });
    }
  }

  return (
    <>
      <div className="settings-debug-field">
        <div className="settings-debug-field-head">
          <label htmlFor={id}>{t("settings.debug.state.content")}</label>
          <Button size="small" disabled={!content.trim()} onClick={handleDecode}>
            {t("settings.debug.state.decodeJwt")}
          </Button>
        </div>
        <Input.TextArea id={id} className="settings-debug-textarea" value={content} readOnly spellCheck={false} />
      </div>
      {currentResult?.error ? (
        <div className="feedback-banner warning-banner" role="alert">{t("settings.debug.state.invalidJwt")}</div>
      ) : null}
      {currentResult?.payload ? (
        <label className="settings-debug-field">
          <span>{t("settings.debug.state.jwtPayload")}</span>
          <Input.TextArea className="settings-debug-textarea" value={currentResult.payload} readOnly spellCheck={false} autoSize={{ minRows: 6, maxRows: 24 }} />
        </label>
      ) : null}
    </>
  );
}
