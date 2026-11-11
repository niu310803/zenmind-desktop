import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";

export function LibraryDeleteNotice({
  chatId,
  className,
}: {
  chatId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    setCount(null);
    if (typeof window.electronAPI.artifacts?.list !== "function") return;
    const load = () => {
      const request = ++generation;
      void window.electronAPI.artifacts.list({ chatId, limit: 1 }).then(result => {
        if (!cancelled && request === generation) setCount(result.total);
      }).catch(() => { if (!cancelled && request === generation) setCount(null); });
    };
    load();
    const unsubscribe = window.electronAPI.artifacts.onChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [chatId]);
  // 仅在资料库确实收录了该对话的资料时提示；查询中或没有条目时不占用弹窗版面。
  if (count === null || count <= 0) return null;
  return (
    <p className={className}>
      {t("artifactManagement.deleteNotice", { count })}
    </p>
  );
}
