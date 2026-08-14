import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const expected = {
  font: {
    bytes: 2_057_688,
    sha256: "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4",
  },
  license: {
    bytes: 4_418,
    sha256: "d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04",
  },
};

async function verify(path, expectation) {
  const bytes = await readFile(path);
  const size = (await stat(path)).size;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (size !== expectation.bytes || sha256 !== expectation.sha256) {
    throw new Error(
      `${path} does not match the pinned Pretendard v1.3.9 asset: ` +
        `expected ${expectation.bytes} bytes / ${expectation.sha256}, ` +
        `received ${size} bytes / ${sha256}`,
    );
  }
  console.log(`verified ${path} (${size} bytes, sha256 ${sha256})`);
  return bytes.toString("utf8");
}

await verify(
  "src/assets/fonts/PretendardVariable.woff2",
  expected.font,
);
const license = await verify(
  "public/licenses/Pretendard/LICENSE",
  expected.license,
);

for (const required of [
  "Copyright (c) 2021, Kil Hyung-jin",
  "Reserved Font Name Pretendard",
  "SIL OPEN FONT LICENSE Version 1.1",
  "PERMISSION & CONDITIONS",
]) {
  if (!license.includes(required)) {
    throw new Error(`Bundled Pretendard license is missing: ${required}`);
  }
}

const builtFonts = (await readdir("dist/assets"))
  .filter((name) => /^PretendardVariable-.*\.woff2$/.test(name));
if (builtFonts.length !== 1) {
  throw new Error(
    `Expected one built Pretendard variable font, found ${builtFonts.length}`,
  );
}
await verify(join("dist/assets", builtFonts[0]), expected.font);
await verify("dist/licenses/Pretendard/LICENSE", expected.license);

const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
for (const required of [
  "Pretendard Variable",
  "SIL Open Font License, Version 1.1",
  expected.font.sha256,
  expected.license.sha256,
]) {
  if (!notices.includes(required)) {
    throw new Error(`THIRD_PARTY_NOTICES.md is missing: ${required}`);
  }
}
