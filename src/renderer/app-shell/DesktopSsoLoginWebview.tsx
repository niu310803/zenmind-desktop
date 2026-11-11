import { createElement, useCallback, useRef, useState } from "react";
import type { DesktopSsoEmbeddedLoginRequest } from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

const SLOW_LOGIN_PAGE_MS = 15_000;
const ERR_ABORTED = -3;
const ERR_INTERNET_DISCONNECTED = -106;

const feedbackKeys = {
  loading: "sidebar.sso.pageLoading",
  offline: "sidebar.sso.pageOffline",
  failed: "sidebar.sso.pageLoadFailed",
  slow: "sidebar.sso.pageLoadSlow"
} as const;

type LoadFailure = "offline" | "failed";
type LoadState = "loading" | "slow" | "ready" | LoadFailure;

export function DesktopSsoLoginWebview({ request }: { request: DesktopSsoEmbeddedLoginRequest }) {
  const { t } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const detachRef = useRef<(() => void) | null>(null);

  const bindWebview = useCallback((webview: Electron.WebviewTag | null) => {
    detachRef.current?.();
    detachRef.current = null;
    if (!webview) {
      return;
    }

    const slowPageTimer = window.setTimeout(() => {
      setLoadState((state) => state === "loading" ? "slow" : state);
    }, SLOW_LOGIN_PAGE_MS);
    const fail = (reason: LoadFailure) => {
      window.clearTimeout(slowPageTimer);
      setLoadState((state) => state === "offline" || state === "failed" ? state : reason);
    };
    const onReady = () => {
      window.clearTimeout(slowPageTimer);
      setLoadState((state) => state === "loading" || state === "slow" ? "ready" : state);
    };
    const onFailLoad = ({ errorCode, isMainFrame }: Electron.DidFailLoadEvent) => {
      if (isMainFrame && errorCode !== ERR_ABORTED) {
        fail(errorCode === ERR_INTERNET_DISCONNECTED || !navigator.onLine ? "offline" : "failed");
      }
    };
    const onNavigate = ({ httpResponseCode, isMainFrame }: Electron.DidFrameNavigateEvent) => {
      if (isMainFrame && httpResponseCode >= 500) {
        fail("failed");
      }
    };
    const onGuestGone = () => fail("failed");
    webview.addEventListener("dom-ready", onReady);
    webview.addEventListener("did-fail-load", onFailLoad);
    webview.addEventListener("did-frame-navigate", onNavigate);
    webview.addEventListener("render-process-gone", onGuestGone);
    detachRef.current = () => {
      window.clearTimeout(slowPageTimer);
      webview.removeEventListener("dom-ready", onReady);
      webview.removeEventListener("did-fail-load", onFailLoad);
      webview.removeEventListener("did-frame-navigate", onNavigate);
      webview.removeEventListener("render-process-gone", onGuestGone);
    };
  }, []);

  const failed = loadState === "offline" || loadState === "failed";
  return (
    <>
      {!failed ? createElement("webview", {
        ref: bindWebview,
        src: request.url,
        title: request.label,
        className: "desktop-sso-login-webview",
        partition: request.partition,
        useragent: request.userAgent,
        style: { visibility: loadState === "ready" ? undefined : "hidden" }
      }) : null}
      {loadState !== "ready" ? (
        <div className="desktop-sso-login-page-feedback" role={failed ? "alert" : "status"} key={failed ? "failure" : "progress"}>
          {t(feedbackKeys[loadState])}
        </div>
      ) : null}
    </>
  );
}
