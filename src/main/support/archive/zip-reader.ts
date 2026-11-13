import { once } from "node:events";
import { crc32 } from "node:zlib";
import { openPromise, type Entry, type ZipFile } from "yauzl";

const MAX_ZIP_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_TEXT_ENTRY_BYTES = 4 * 1024 * 1024;

async function withZipFile<T>(archivePath: string, read: (zip: ZipFile) => Promise<T>): Promise<T> {
  const zip = await openPromise(archivePath, { autoClose: false });
  try {
    return await read(zip);
  } finally {
    const closed = once(zip, "close");
    zip.close();
    await closed;
  }
}

async function* readZipDirectory(zip: ZipFile) {
  let metadataBytes = 0;
  for await (const entry of zip.eachEntry()) {
    // Count headers as well so an archive with short or duplicate names stays bounded.
    metadataBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
    if (metadataBytes > MAX_ZIP_METADATA_BYTES) {
      throw new Error("ZIP directory exceeds the metadata size limit");
    }
    yield entry;
  }
}

export function listZipEntries(archivePath: string) {
  return withZipFile(archivePath, async (zip) => {
    const names = new Set<string>();
    for await (const entry of readZipDirectory(zip)) {
      const name = entry.fileName.trim();
      if (name) {
        names.add(name);
      }
    }
    return names;
  });
}

async function readEntryBytes(zip: ZipFile, entry: Entry) {
  if (entry.uncompressedSize > MAX_ZIP_TEXT_ENTRY_BYTES) {
    throw new Error(`ZIP entry exceeds the metadata size limit: ${entry.fileName}`);
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  let checksum = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_ZIP_TEXT_ENTRY_BYTES) {
      throw new Error(`ZIP entry exceeds the metadata size limit: ${entry.fileName}`);
    }
    checksum = crc32(chunk, checksum);
    chunks.push(chunk);
  }
  if (checksum !== entry.crc32) {
    throw new Error(`ZIP entry checksum mismatch: ${entry.fileName}`);
  }
  return Buffer.concat(chunks, size);
}

export function readZipEntryText(archivePath: string, matches: (entryName: string) => boolean) {
  return withZipFile(archivePath, async (zip) => {
    for await (const entry of readZipDirectory(zip)) {
      const name = entry.fileName.trim();
      if (!name.endsWith("/") && matches(name)) {
        const bytes = await readEntryBytes(zip, entry);
        return bytes.toString("utf8").replace(/^\uFEFF/u, "");
      }
    }
    return null;
  });
}
