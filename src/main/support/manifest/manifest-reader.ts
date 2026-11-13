import fs from "node:fs";
import { type Manifest } from "../../../shared/contracts";
import { isZipArchive, listArchiveEntries, readFileFromArchive } from "../archive/archive-utils";
import { readZipEntryText } from "../archive/zip-reader";

export function readManifestFile(manifestPath: string) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

export async function readManifestFromArchive(archivePath: string, options?: { cache?: boolean }) {
  if (isZipArchive(archivePath)) {
    const manifest = await readZipEntryText(archivePath, (name) =>
      name === "manifest.json" || name.endsWith("/manifest.json")
    );
    if (manifest === null) {
      throw new Error(`archive does not contain manifest.json: ${archivePath}`);
    }
    return JSON.parse(manifest) as Manifest;
  }
  const entries = await listArchiveEntries(archivePath, options);
  const manifestEntry = [...entries].find((entry) =>
    entry.endsWith("/manifest.json") || entry.endsWith("\\manifest.json") || entry === "manifest.json"
  );
  if (!manifestEntry) {
    throw new Error(`archive does not contain manifest.json: ${archivePath}`);
  }

  const manifestContent = await readFileFromArchive(archivePath, manifestEntry);
  return JSON.parse(manifestContent) as Manifest;
}
