import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const expected = {
  pretendard: {
    font: {
      bytes: 2_057_688,
      sha256: "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4",
    },
    license: {
      bytes: 4_418,
      sha256: "d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04",
    },
  },
  jetendard: {
    releaseArchive: {
      bytes: 26_488_266,
      sha256: "42101ca2849d79e6356ebe8841d010fc558365ace1e737d85496dc3061539159",
      url: "https://github.com/kuskhan/jetendard/releases/download/v0.1.0/Jetendard-WebFont.zip",
    },
    fonts: {
      "Jetendard-Regular.woff2": {
        bytes: 1_680_500,
        sha256: "a92e12e86d773a41915a92dc87d113f13f954a688508060e4cc3fa93ed08f189",
      },
      "Jetendard-SemiBold.woff2": {
        bytes: 1_689_308,
        sha256: "00e92336e1ac1c596b95a06a3120d58d35f23d306834dbb3938032db02f7ee86",
      },
      "Jetendard-Bold.woff2": {
        bytes: 1_693_208,
        sha256: "d128ebd88b0dbd3ea5441768970e53fbad1044d138904b3dd7ff15a49c3f075d",
      },
    },
    license: {
      bytes: 4_640,
      sha256: "c6bd5bf88860a4baab08368d5a42cc82863e394400810719352a990d7fda78cb",
    },
  },
};

async function verify(path, expectation, component) {
  const bytes = await readFile(path);
  const size = (await stat(path)).size;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (size !== expectation.bytes || sha256 !== expectation.sha256) {
    throw new Error(
      `${path} does not match the pinned ${component} asset: ` +
        `expected ${expectation.bytes} bytes / ${expectation.sha256}, ` +
        `received ${size} bytes / ${sha256}`,
    );
  }
  console.log(`verified ${path} (${size} bytes, sha256 ${sha256})`);
  return bytes.toString("utf8");
}

await verify(
  "src/assets/fonts/PretendardVariable.woff2",
  expected.pretendard.font,
  "Pretendard v1.3.9",
);
const pretendardLicense = await verify(
  "public/licenses/Pretendard/LICENSE",
  expected.pretendard.license,
  "Pretendard v1.3.9",
);

for (const required of [
  "Copyright (c) 2021, Kil Hyung-jin",
  "Reserved Font Name Pretendard",
  "SIL OPEN FONT LICENSE Version 1.1",
  "PERMISSION & CONDITIONS",
]) {
  if (!pretendardLicense.includes(required)) {
    throw new Error(`Bundled Pretendard license is missing: ${required}`);
  }
}

const jetendardSourceDir = "src/assets/fonts/Jetendard";
for (const [fileName, expectation] of Object.entries(expected.jetendard.fonts)) {
  await verify(
    join(jetendardSourceDir, fileName),
    expectation,
    "Jetendard v0.1.0",
  );
}
const jetendardLicense = await verify(
  "public/licenses/Jetendard/LICENSE",
  expected.jetendard.license,
  "Jetendard v0.1.0",
);
for (const required of [
  "Copyright (c) 2026 Jung Woong Park",
  'Reserved Font Name "Jetendard"',
  "SIL OPEN FONT LICENSE Version 1.1",
  "PERMISSION & CONDITIONS",
]) {
  if (!jetendardLicense.includes(required)) {
    throw new Error(`Bundled Jetendard license is missing: ${required}`);
  }
}

const builtAssets = await readdir("dist/assets");
const builtPretendard = builtAssets.filter((name) =>
  /^PretendardVariable-.*\.woff2$/.test(name),
);
if (builtPretendard.length !== 1) {
  throw new Error(
    `Expected one built Pretendard variable font, found ${builtPretendard.length}`,
  );
}
await verify(
  join("dist/assets", builtPretendard[0]),
  expected.pretendard.font,
  "Pretendard v1.3.9",
);
await verify(
  "dist/licenses/Pretendard/LICENSE",
  expected.pretendard.license,
  "Pretendard v1.3.9",
);

for (const [fileName, expectation] of Object.entries(expected.jetendard.fonts)) {
  const stem = fileName.slice(0, -".woff2".length);
  const built = builtAssets.filter((name) =>
    new RegExp(`^${stem}-.*\\.woff2$`).test(name),
  );
  if (built.length !== 1) {
    throw new Error(`Expected one built ${stem} font, found ${built.length}`);
  }
  await verify(
    join("dist/assets", built[0]),
    expectation,
    "Jetendard v0.1.0",
  );
}
await verify(
  "dist/licenses/Jetendard/LICENSE",
  expected.jetendard.license,
  "Jetendard v0.1.0",
);

const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
for (const required of [
  "Pretendard Variable",
  "Jetendard",
  "SIL Open Font License, Version 1.1",
  expected.pretendard.font.sha256,
  expected.pretendard.license.sha256,
  expected.jetendard.releaseArchive.url,
  expected.jetendard.releaseArchive.sha256,
  ...Object.values(expected.jetendard.fonts).map(({ sha256 }) => sha256),
  expected.jetendard.license.sha256,
]) {
  if (!notices.includes(required)) {
    throw new Error(`THIRD_PARTY_NOTICES.md is missing: ${required}`);
  }
}
