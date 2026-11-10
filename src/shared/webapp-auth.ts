/** Page-only session exchange; never returns credentials. */
export const WEBAPP_AUTH_CHANNEL = "webapp.auth.createSession";
export function pageAuthGlobal(brandId: string) {
  if (brandId === "zenmind") return "__ZENMIND_AUTH__";
  if (brandId === "cutej") return "__CUTEJ_AUTH__";
  throw new Error(`Unsupported page auth brand: ${brandId}`);
}
export interface WebappAuthSessionInput { exchangePath: string }
export type WebappAuthSessionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };
