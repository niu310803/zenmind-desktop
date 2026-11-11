import { useMemo } from "react";
import { Input } from "antd";
import { useI18n } from "../../i18n/useI18n";
import { decodeJwtPayload } from "./decodeJwtPayload";

export function SsoIdTokenDebugField({ content }: { content: string }) {
  const { t } = useI18n();
  const result = useMemo(() => {
    if (!content.trim()) return null;
    try {
      return { payload: decodeJwtPayload(content), error: false };
    } catch {
      return { payload: "", error: true };
    }
  }, [content]);

  return (
    <>
      <label className="settings-debug-field">
        <Input.TextArea aria-label={t("settings.debug.state.content")} className="settings-debug-textarea" value={content} readOnly spellCheck={false} />
      </label>
      {result?.error ? (
        <div className="feedback-banner warning-banner" role="alert">{t("settings.debug.state.invalidJwt")}</div>
      ) : null}
      {result?.payload ? (
        <label className="settings-debug-field">
          <span>{t("settings.debug.state.jwtPayload")}</span>
          <Input.TextArea className="settings-debug-textarea" value={result.payload} readOnly spellCheck={false} autoSize={{ minRows: 6, maxRows: 24 }} />
        </label>
      ) : null}
    </>
  );
}
