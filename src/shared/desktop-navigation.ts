import { DESKTOP_OPEN_PROTOCOL_SCHEME } from "./brand";

// Public deep links may navigate only to static product pages, never actions,
// arbitrary URLs, files, query parameters or private conversation identities.
export const DESKTOP_NAVIGATION_PATHS: readonly string[] = [
  "/",
  "/agents",
  "/kbases",
  "/memory",
  "/skills",
  "/connectors",
  "/registries",
  "/archives",
  "/market",
  "/artifact-management",
  "/share-management",
  "/kanban",
  "/automations",
  "/help",
  "/settings",
  "/settings/general",
  "/settings/appearance",
  "/settings/usage",
  "/settings/assistant",
  "/settings/navigation",
  "/settings/control",
  "/settings/localServices",
  "/settings/browser",
  "/settings/kanban",
  "/settings/market",
  "/settings/tunnelHub",
  "/settings/plugins",
  "/settings/websiteCredentials",
  "/settings/websites",
  "/settings/websiteBridges",
  "/settings/webapps",
  "/settings/about",
  "/settings/debug"
];
const allowedPaths = new Set(DESKTOP_NAVIGATION_PATHS);

export function readDesktopNavigationUrl(value: unknown, scheme = DESKTOP_OPEN_PROTOCOL_SCHEME): string | null {
  if (typeof value !== "string" || /[\s\u0000-\u001f\u007f]/u.test(value) || value.includes("#") || !value.startsWith(`${scheme}://navigate?`)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== `${scheme}:` || url.host !== "navigate" || url.pathname ||
        url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 1 ||
        !url.searchParams.has("path")) return null;
    const path = url.searchParams.get("path")!;
    return allowedPaths.has(path) ? path : null;
  } catch { return null; }
}
