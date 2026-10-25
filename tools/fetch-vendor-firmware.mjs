import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TOOL_DIR, "..");
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, "tests", "real-app", "vendor-firmware.json");
const DEFAULT_DIR = join(REPOSITORY_ROOT, ".cache", "vendor-firmware");
const SHA256 = /^[0-9a-f]{64}$/iu;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/iu;
const IDENTITY_FIELDS = [
  "boardManufacturer",
  "boardProduct",
  "boardVersion",
  "biosVendor",
  "biosVersion",
  "biosReleaseDate",
];
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(object, field, label, { nonempty = false } = {}) {
  if (typeof object[field] !== "string" || (nonempty && object[field].length === 0)) {
    throw new Error(`${label}.${field} must be ${nonempty ? "a non-empty string" : "a string"}`);
  }
}

function requireSize(object, field, label) {
  if (!Number.isSafeInteger(object[field]) || object[field] <= 0) {
    throw new Error(`${label}.${field} must be a positive integer`);
  }
}

/** Validates a vendor-firmware manifest and returns it unchanged. */
export function validateManifest(manifest) {
  if (!isObject(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.schema !== 1) {
    throw new Error("manifest.schema must be 1");
  }
  if (!Array.isArray(manifest.images)) {
    throw new Error("manifest.images must be an array");
  }

  const ids = new Set();
  for (const [index, image] of manifest.images.entries()) {
    const label = `manifest.images[${index}]`;
    if (!isObject(image)) {
      throw new Error(`${label} must be an object`);
    }

    requireString(image, "id", label, { nonempty: true });
    if (!SAFE_ID.test(image.id)) {
      throw new Error(`${label}.id must contain only letters, numbers, dots, underscores, and hyphens`);
    }
    if (ids.has(image.id)) {
      throw new Error(`${label}.id duplicates id "${image.id}"`);
    }
    ids.add(image.id);

    requireString(image, "url", label, { nonempty: true });
    let url;
    try {
      url = new URL(image.url);
    } catch {
      throw new Error(`${label}.url must be a valid HTTPS URL`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`${label}.url must be a valid HTTPS URL`);
    }
    if (!posix.basename(url.pathname)) {
      throw new Error(`${label}.url must end with an archive filename`);
    }

    for (const field of ["archiveSha256", "imageSha256"]) {
      requireString(image, field, label);
      if (!SHA256.test(image[field])) {
        throw new Error(`${label}.${field} must be a 64-character hexadecimal SHA-256`);
      }
    }
    requireSize(image, "archiveBytes", label);
    requireSize(image, "imageBytes", label);

    requireString(image, "member", label, { nonempty: true });
    const memberSegments = image.member.split("/");
    if (
      image.member.startsWith("/") ||
      image.member.endsWith("/") ||
      image.member.includes("\\") ||
      memberSegments.includes("..")
    ) {
      throw new Error(`${label}.member must be a file path using forward slashes, without a leading slash or .. segment`);
    }

    if (!isObject(image.identity)) {
      throw new Error(`${label}.identity must be an object`);
    }
    for (const field of IDENTITY_FIELDS) {
      requireString(image.identity, field, `${label}.identity`);
    }
    requireString(image, "outcome", label, { nonempty: true });
  }

  return manifest;
}

/** Returns the fixed destination path for an image. */
export function imagePath(dir, image) {
  return join(dir, "images", image.id, posix.basename(image.member));
}

function manifestValue(manifest) {
  if (typeof manifest === "string" || manifest instanceof URL) {
    let text;
    try {
      text = readFileSync(manifest, "utf8");
    } catch (error) {
      throw new Error(`Could not read vendor manifest ${String(manifest)}: ${error.message}`, {
        cause: error,
      });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Could not parse vendor manifest ${String(manifest)}: ${error.message}`, {
        cause: error,
      });
    }
  }
  return manifest;
}

function configuredDefaultDir(environment = process.env) {
  const configured = environment.NVSTRAPS_VENDOR_FIRMWARE_DIR;
  return configured ? resolve(configured) : DEFAULT_DIR;
}

/** Loads and validates the manifest without downloading its images. */
export function loadVendorImages({ dir = configuredDefaultDir(), manifest = DEFAULT_MANIFEST } = {}) {
  const parsed = validateManifest(manifestValue(manifest));
  return parsed.images.map((image) => ({ ...image, imagePath: imagePath(dir, image) }));
}

function zipError(message) {
  return new Error(`Invalid ZIP archive: ${message}`);
}

function need(buffer, offset, length, description, limit = buffer.length) {
  if (offset < 0 || length < 0 || offset + length > limit || offset + length > buffer.length) {
    throw zipError(`${description} is truncated`);
  }
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) {
    throw zipError("End of Central Directory record is missing");
  }
  const firstPossible = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= firstPossible; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength <= buffer.length) {
      return offset;
    }
  }
  throw zipError("End of Central Directory record is missing");
}

/** Reads exactly one member from a non-ZIP64 ZIP buffer. */
export function readZipMember(buffer, member) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("buffer must be a Buffer");
  }
  if (typeof member !== "string" || member.length === 0) {
    throw new TypeError("member must be a non-empty string");
  }

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw zipError("ZIP64 sizes are not supported");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError("multi-disk archives are not supported");
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw zipError("central directory is outside the archive");
  }

  const centralEnd = centralOffset + centralSize;
  const wantedName = Buffer.from(member, "utf8");
  let cursor = centralOffset;
  let found = null;

  for (let index = 0; index < entryCount; index += 1) {
    need(buffer, cursor, 46, "central directory entry", centralEnd);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw zipError(`central directory entry ${index} has the wrong signature`);
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    need(buffer, cursor, entryLength, "central directory entry", centralEnd);

    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    if (name.equals(wantedName)) {
      if (found) {
        throw zipError(`member "${member}" occurs more than once`);
      }
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw zipError(`member "${member}" uses ZIP64 sizes, which are not supported`);
      }
      if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
        throw zipError(`member "${member}" is encrypted; encrypted entries are not supported`);
      }
      if (method !== 0 && method !== 8) {
        throw zipError(`member "${member}" uses unsupported compression method ${method}`);
      }
      found = { flags, method, compressedSize, uncompressedSize, localOffset, name };
    }
    cursor += entryLength;
  }

  if (!found) {
    throw zipError(`member "${member}" was not found`);
  }

  need(buffer, found.localOffset, 30, `local header for member "${member}"`);
  if (buffer.readUInt32LE(found.localOffset) !== 0x04034b50) {
    throw zipError(`local header for member "${member}" has the wrong signature`);
  }
  const localFlags = buffer.readUInt16LE(found.localOffset + 6);
  const localMethod = buffer.readUInt16LE(found.localOffset + 8);
  const localCompressedSize = buffer.readUInt32LE(found.localOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(found.localOffset + 22);
  const localNameLength = buffer.readUInt16LE(found.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(found.localOffset + 28);
  if (localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
    throw zipError(`member "${member}" uses ZIP64 sizes, which are not supported`);
  }
  if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0) {
    throw zipError(`member "${member}" is encrypted; encrypted entries are not supported`);
  }
  if (localMethod !== found.method) {
    throw zipError(`member "${member}" has inconsistent compression methods`);
  }
  if ((localFlags & 0x0008) === 0 && (
    localCompressedSize !== found.compressedSize ||
    localUncompressedSize !== found.uncompressedSize
  )) {
    throw zipError(`member "${member}" has inconsistent sizes`);
  }

  const localNameOffset = found.localOffset + 30;
  need(buffer, localNameOffset, localNameLength + localExtraLength, `local header for member "${member}"`);
  const localName = buffer.subarray(localNameOffset, localNameOffset + localNameLength);
  if (!localName.equals(found.name)) {
    throw zipError(`member "${member}" has inconsistent names`);
  }
  const dataOffset = localNameOffset + localNameLength + localExtraLength;
  need(buffer, dataOffset, found.compressedSize, `compressed data for member "${member}"`);
  const compressed = buffer.subarray(dataOffset, dataOffset + found.compressedSize);

  let contents;
  if (found.method === 0) {
    contents = Buffer.from(compressed);
  } else {
    try {
      contents = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, found.uncompressedSize),
      });
    } catch (error) {
      throw zipError(`member "${member}" could not be inflated: ${error.message}`);
    }
  }
  if (contents.length !== found.uncompressedSize) {
    throw zipError(
      `member "${member}" has size ${contents.length}, expected ${found.uncompressedSize}`,
    );
  }
  return contents;
}

function archivePath(dir, image) {
  return join(dir, "archives", posix.basename(new URL(image.url).pathname));
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fileMatches(file, expectedBytes, expectedSha256) {
  let details;
  try {
    details = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!details.isFile() || details.size !== expectedBytes) {
    return false;
  }
  return (await sha256File(file)) === expectedSha256.toLowerCase();
}

class DownloadVerificationError extends Error {}

async function downloadArchive(image, destination) {
  const partial = `${destination}.partial`;
  let lastError;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    await rm(partial, { force: true });
    try {
      const response = await fetch(image.url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      if (new URL(response.url).protocol !== "https:") {
        await response.body.cancel();
        throw new Error("the download redirected to a non-HTTPS URL");
      }

      let bytes = 0;
      const hash = createHash("sha256");
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        verifier,
        createWriteStream(partial, { flags: "wx" }),
      );
      const sha256 = hash.digest("hex");
      if (bytes !== image.archiveBytes || sha256 !== image.archiveSha256.toLowerCase()) {
        throw new DownloadVerificationError(
          `archive verification failed: expected ${image.archiveBytes} bytes and SHA-256 ` +
          `${image.archiveSha256}; got ${bytes} bytes and SHA-256 ${sha256}`,
        );
      }

      await rm(destination, { force: true });
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (error instanceof DownloadVerificationError || attempt === DOWNLOAD_ATTEMPTS) {
        break;
      }
      await delay(500 * (2 ** (attempt - 1)));
    }
  }

  if (lastError instanceof DownloadVerificationError) {
    throw lastError;
  }
  throw new Error(`download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${lastError.message}`, {
    cause: lastError,
  });
}

function verifyExtractedImage(image, contents) {
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (contents.length !== image.imageBytes || sha256 !== image.imageSha256.toLowerCase()) {
    throw new Error(
      `image verification failed: expected ${image.imageBytes} bytes and SHA-256 ` +
      `${image.imageSha256}; got ${contents.length} bytes and SHA-256 ${sha256}`,
    );
  }
}

async function installImage(destination, contents) {
  const partial = `${destination}.partial`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(partial, { force: true });
  try {
    await writeFile(partial, contents, { flag: "wx" });
    await rm(destination, { force: true });
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function fetchImage(dir, image) {
  if (await fileMatches(image.imagePath, image.imageBytes, image.imageSha256)) {
    return "cached";
  }

  const archive = archivePath(dir, image);
  await mkdir(dirname(archive), { recursive: true });
  let downloaded = false;
  if (!(await fileMatches(archive, image.archiveBytes, image.archiveSha256))) {
    await downloadArchive(image, archive);
    downloaded = true;
  }

  const contents = readZipMember(await readFile(archive), image.member);
  verifyExtractedImage(image, contents);
  await installImage(image.imagePath, contents);
  return downloaded ? "downloaded and extracted" : "extracted";
}

function commandPath(value) {
  return isAbsolute(value) ? value : resolve(value);
}

function parseArguments(argv, environment) {
  let dir = configuredDefaultDir(environment);
  let manifest = DEFAULT_MANIFEST;
  let only = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--dir" && argument !== "--manifest" && argument !== "--only") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--dir") {
      dir = commandPath(value);
    } else if (argument === "--manifest") {
      manifest = commandPath(value);
    } else {
      const ids = value.split(",");
      if (ids.some((id) => id.length === 0)) {
        throw new Error("--only requires one or more comma-separated ids");
      }
      only ??= new Set();
      for (const id of ids) {
        only.add(id);
      }
    }
  }

  return { dir, manifest, only };
}

/** Runs the vendor firmware fetch command. */
export async function run(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  const allImages = loadVendorImages({ dir: options.dir, manifest: options.manifest });
  let images = allImages;
  if (options.only) {
    const known = new Set(allImages.map((image) => image.id));
    const unknown = [...options.only].filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown --only id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    }
    images = allImages.filter((image) => options.only.has(image.id));
  }

  const failures = [];
  for (const image of images) {
    try {
      const action = await fetchImage(options.dir, image);
      console.log(`${image.id}: ${action}: ${image.imagePath}`);
    } catch (error) {
      failures.push({ id: image.id, message: error.message });
      console.error(`${image.id}: failed: ${error.message}: ${image.imagePath}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `Failed ${failures.length} of ${images.length} vendor image${images.length === 1 ? "" : "s"}: ` +
      failures.map((failure) => failure.id).join(", "),
    );
    return false;
  }
  return true;
}

async function main() {
  try {
    if (!(await run())) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Vendor firmware fetch failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
