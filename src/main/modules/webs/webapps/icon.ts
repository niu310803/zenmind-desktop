import fs from "node:fs";
import path from "node:path";
import type { WebappFrontendConfig } from "../../../../shared/webapp-manifest";

const ICON_MAX_BYTES = 256 * 1024;
const HTML_HEAD_MAX_BYTES = 512 * 1024;
const ICON_ORIGIN = "https://webapp-icon.invalid";
const PACKAGE_ICON_FILES = ["icon.svg", "icon.png"];
const FALLBACK_ICON_PATHS = ["/favicon.svg", "/favicon.png", "/favicon.ico", "/apple-touch-icon.png"];

function isInsideRoot(root: string, candidate: string, platform: NodeJS.Platform) {
  // Windows comparisons must understand drive roots, separators, and case.
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(root, candidate);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

/** Resolve only frontend-local URL paths; never fetch a remote favicon. */
export function resolveWebappIconPath(
  frontendRoot: string,
  index: string,
  href: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (!href || /[\\\u0000]/u.test(href) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) return "";
  try {
    const url = new URL(href, new URL(index.replaceAll("\\", "/"), `${ICON_ORIGIN}/`));
    if (url.origin !== ICON_ORIGIN) return "";
    const decodedPath = decodeURIComponent(url.pathname);
    // Colons also reject Windows drive paths and alternate data streams.
    if (/[\\:\u0000]/u.test(decodedPath)) return "";
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const candidate = pathApi.resolve(frontendRoot, ...decodedPath.slice(1).split("/"));
    return isInsideRoot(frontendRoot, candidate, platform) ? candidate : "";
  } catch {
    return "";
  }
}

function readContainedFile(root: string, filename: string, maxBytes: number, prefixOnly = false) {
  if (!filename || !isInsideRoot(root, filename, process.platform)) return null;
  let fd: number | undefined;
  try {
    const realPath = fs.realpathSync(filename);
    if (!isInsideRoot(root, realPath, process.platform)) return null;
    fd = fs.openSync(realPath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || (!prefixOnly && stat.size > maxBytes)) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0) return "image/x-icon";
  const svg = bytes.toString("utf8").trim();
  if (!/<!DOCTYPE|<!ENTITY/iu.test(svg) && /^(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(svg)) return "image/svg+xml";
  return "";
}

function toImageDataUrl(bytes: Buffer | null) {
  if (!bytes || bytes.length === 0 || bytes.length > ICON_MAX_BYTES) return "";
  const mime = imageMime(bytes);
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : "";
}

function readInlineImage(href: string) {
  if (href.length > ICON_MAX_BYTES * 4) return "";
  const match = /^data:(image\/(?:png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml))(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/iu.exec(href);
  if (!match) return "";
  try {
    const bytes = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
    const mime = imageMime(bytes);
    const declaredMime = match[1]!.toLowerCase().replace("image/jpg", "image/jpeg").replace("image/vnd.microsoft.icon", "image/x-icon");
    return mime === declaredMime ? toImageDataUrl(bytes) : "";
  } catch {
    return "";
  }
}

function decodeAttribute(value: string) {
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (entity, name: string) => {
    if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
    const codePoint = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function declaredIconHrefs(html: string) {
  const links: Array<{ href: string; priority: number }> = [];
  const markup = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, "");
  // Quoted attribute values may contain SVG markup, including literal > signs.
  for (const tag of markup.matchAll(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[0].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu)) {
      attributes.set(attribute[1]!.toLowerCase(), decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
    }
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/u);
    const href = (attributes.get("href") ?? "").trim();
    if (href && (rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed"))) {
      links.push({ href, priority: rel.includes("icon") ? 0 : 1 });
    }
  }
  return links.sort((a, b) => a.priority - b.priority).map(link => link.href);
}

/** Derived presentation data only; the app need not be running. */
export function readWebappIconDataUrl(webappDir: string, frontend: Pick<WebappFrontendConfig, "root" | "index">) {
  try {
    const packageRoot = fs.realpathSync(webappDir);
    // Package presentation assets sit beside webapp.json, independent of the frontend.
    const assetsRoot = path.join(packageRoot, "assets");
    for (const filename of PACKAGE_ICON_FILES) {
      const dataUrl = toImageDataUrl(readContainedFile(assetsRoot, path.join(assetsRoot, filename), ICON_MAX_BYTES));
      if (dataUrl) return dataUrl;
    }
    const frontendRoot = fs.realpathSync(path.resolve(packageRoot, ...frontend.root.replaceAll("\\", "/").split("/")));
    if (!isInsideRoot(packageRoot, frontendRoot, process.platform)) return "";
    const indexPath = path.resolve(frontendRoot, ...frontend.index.replaceAll("\\", "/").split("/"));
    const html = readContainedFile(frontendRoot, indexPath, HTML_HEAD_MAX_BYTES, true)?.toString("utf8") ?? "";
    for (const href of [...declaredIconHrefs(html), ...FALLBACK_ICON_PATHS]) {
      const dataUrl = href.toLowerCase().startsWith("data:")
        ? readInlineImage(href)
        : toImageDataUrl(readContainedFile(frontendRoot, resolveWebappIconPath(frontendRoot, frontend.index, href), ICON_MAX_BYTES));
      if (dataUrl) return dataUrl;
    }
  } catch {
    // Missing or malformed icons must not prevent the application from listing.
  }
  return "";
}
