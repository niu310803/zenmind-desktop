// Diagnostic decoding only; this does not verify the signature or authenticate claims.
export function decodeJwtPayload(token: string): string {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    throw new Error("Invalid JWT");
  }
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid JWT payload");
  }
  return JSON.stringify(payload, null, 2);
}
