import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
  imagePath,
  loadVendorImages,
  readZipMember,
  validateManifest,
} from "./fetch-vendor-firmware.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(REPOSITORY_ROOT, "tests", "real-app", "vendor-firmware.json");
const REAL_MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.from(entry.contents);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const compressed = entry.compressed ?? (method === 8 ? deflateRawSync(contents) : contents);
    const crc = crc32(contents);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([localHeader, name, compressed]);
    localParts.push(localPart);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(Buffer.concat([centralHeader, name]));

    localOffset += localPart.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("reads a stored ZIP member", () => {
  const expected = Buffer.from("stored firmware bytes");
  const zip = buildZip([{ name: "firmware.bin", contents: expected }]);
  assert.deepEqual(readZipMember(zip, "firmware.bin"), expected);
});

test("reads a deflated ZIP member after walking the central directory", () => {
  const expected = Buffer.from("deflated firmware bytes ".repeat(50));
  const zip = buildZip([
    { name: "readme.txt", contents: Buffer.from("not this one") },
    { name: "firmware.bin", contents: expected, method: 8 },
  ]);
  assert.deepEqual(readZipMember(zip, "firmware.bin"), expected);
});

test("reads a member inside a folder", () => {
  const expected = Buffer.from([0, 1, 2, 3, 255]);
  const zip = buildZip([{ name: "board/firmware.bin", contents: expected }]);
  assert.deepEqual(readZipMember(zip, "board/firmware.bin"), expected);
});

test("allows vendor data after the End of Central Directory record", () => {
  const expected = Buffer.from("firmware followed by a vendor signature");
  const zip = Buffer.concat([
    buildZip([{ name: "firmware.bin", contents: expected }]),
    Buffer.alloc(256, 0xa5),
  ]);
  assert.deepEqual(readZipMember(zip, "firmware.bin"), expected);
});

test("reports a missing ZIP member", () => {
  const zip = buildZip([{ name: "present.bin", contents: Buffer.from("present") }]);
  assert.throws(() => readZipMember(zip, "missing.bin"), /member "missing\.bin" was not found/u);
});

test("rejects an unsupported ZIP compression method", () => {
  const zip = buildZip([{
    name: "firmware.bin",
    contents: Buffer.from("unsupported"),
    method: 12,
  }]);
  assert.throws(() => readZipMember(zip, "firmware.bin"), /unsupported compression method 12/u);
});

test("rejects an encrypted ZIP member", () => {
  const zip = buildZip([{
    name: "firmware.bin",
    contents: Buffer.from("encrypted"),
    flags: 1,
  }]);
  assert.throws(() => readZipMember(zip, "firmware.bin"), /member "firmware\.bin" is encrypted/u);
});

test("rejects ZIP64 member sizes", () => {
  const name = "firmware.bin";
  const contents = Buffer.from("too large, allegedly");
  const zip = buildZip([{ name, contents }]);
  const centralOffset = 30 + Buffer.byteLength(name) + contents.length;
  zip.writeUInt32LE(0xffffffff, centralOffset + 24);
  assert.throws(() => readZipMember(zip, name), /ZIP64 sizes/u);
});

test("the checked-in vendor manifest passes validation", () => {
  assert.equal(validateManifest(REAL_MANIFEST), REAL_MANIFEST);
});

test("manifest validation names every malformed field", () => {
  const variants = [
    ["schema", (manifest) => { manifest.schema = 2; }],
    ["images", (manifest) => { manifest.images = null; }],
    ["id", (manifest) => { delete manifest.images[0].id; }],
    ["id", (manifest) => { manifest.images[0].id = "../outside"; }],
    ["id", (manifest) => { manifest.images[1].id = manifest.images[0].id; }],
    ["url", (manifest) => { manifest.images[0].url = "http://example.com/firmware.zip"; }],
    ["archiveSha256", (manifest) => { manifest.images[0].archiveSha256 = "1234"; }],
    ["archiveBytes", (manifest) => { manifest.images[0].archiveBytes = 0; }],
    ["member", (manifest) => { manifest.images[0].member = "/firmware.bin"; }],
    ["member", (manifest) => { manifest.images[0].member = "folder/../firmware.bin"; }],
    ["imageSha256", (manifest) => { delete manifest.images[0].imageSha256; }],
    ["imageBytes", (manifest) => { manifest.images[0].imageBytes = 1.5; }],
    ["identity", (manifest) => { manifest.images[0].identity = []; }],
    ["boardManufacturer", (manifest) => { delete manifest.images[0].identity.boardManufacturer; }],
    ["boardProduct", (manifest) => { manifest.images[0].identity.boardProduct = 7; }],
    ["boardVersion", (manifest) => { delete manifest.images[0].identity.boardVersion; }],
    ["biosVendor", (manifest) => { delete manifest.images[0].identity.biosVendor; }],
    ["biosVersion", (manifest) => { delete manifest.images[0].identity.biosVersion; }],
    ["biosReleaseDate", (manifest) => { delete manifest.images[0].identity.biosReleaseDate; }],
    ["outcome", (manifest) => { manifest.images[0].outcome = null; }],
  ];

  for (const [field, mutate] of variants) {
    const malformed = structuredClone(REAL_MANIFEST);
    mutate(malformed);
    assert.throws(
      () => validateManifest(malformed),
      (error) => {
        assert.match(error.message, new RegExp(field, "u"), field);
        return true;
      },
      field,
    );
  }
});

test("image paths use the member basename and loading does not download", () => {
  const dir = resolve("vendor-cache-for-test");
  const image = REAL_MANIFEST.images[3];
  const expected = join(dir, "images", image.id, "E7C02AMS.HD0");
  assert.equal(imagePath(dir, image), expected);

  const loaded = loadVendorImages({ dir, manifest: REAL_MANIFEST });
  assert.equal(loaded.length, REAL_MANIFEST.images.length);
  assert.equal(loaded[3].imagePath, expected);
  assert.equal(loaded[3].member, image.member);
});
