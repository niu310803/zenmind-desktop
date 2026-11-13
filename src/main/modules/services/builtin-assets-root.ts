import path from "node:path";
import type { App } from "electron";

export function getBuiltinAssetsRoot(app: App) {
  if (process.env.DESKTOP_BUILTIN_ASSETS_ROOT) {
    return process.env.DESKTOP_BUILTIN_ASSETS_ROOT;
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "services")
    : path.join(process.cwd(), "build", "resources", "services");
}
