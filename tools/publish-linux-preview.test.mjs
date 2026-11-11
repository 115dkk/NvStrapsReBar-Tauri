import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checksumLines, previewIdentity, previewNotes, previewPackages, releaseArguments } from "./publish-linux-preview.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const env = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/master",
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: "115dkk/NvStrapsReBar-Tauri",
};
const files = [
  { name: "nvstraps-rebar_1.2.3_amd64.deb", sha256: "a".repeat(64) },
  { name: "nvstraps-rebar-1.2.3-1.x86_64.rpm", sha256: "b".repeat(64) },
];

test("the preview is published only by hand from master, for a plain version", () => {
  assert.deepEqual(previewIdentity(env, "1.2.3"),
    { version: "1.2.3", tag: "linux-preview-1.2.3", sha, repo: "115dkk/NvStrapsReBar-Tauri" });
  assert.throws(() => previewIdentity({ ...env, GITHUB_EVENT_NAME: "push" }, "1.2.3"), /by hand from master/);
  assert.throws(() => previewIdentity({ ...env, GITHUB_REF: "refs/heads/feature" }, "1.2.3"), /by hand from master/);
  assert.throws(() => previewIdentity(env, "1.2.3-rc.1"), /not <major>\.<minor>\.<patch>/);
  assert.throws(() => previewIdentity({ ...env, GITHUB_SHA: "short" }, "1.2.3"), /identity/);
});

test("the preview tag stays invisible to the release planner", () => {
  const { tag } = previewIdentity(env, "1.2.3");
  // tools/release-plan.mjs takes its baseline from `git describe --match "v[0-9]*"`.
  const planner = readFileSync(new URL("./release-plan.mjs", import.meta.url), "utf8");
  assert.match(planner, /"--match", "v\[0-9\]\*"/, "the planner still selects its baseline by this pattern");
  assert.ok(!/^v[0-9]/.test(tag), `${tag} must not look like a stable release tag`);
});

test("exactly one package of each kind is published", () => {
  // Joined here as the tool joins them, so the test also runs where the separator is a backslash.
  const deb = join("target", "release", "bundle", "deb");
  const rpm = join("target", "release", "bundle", "rpm");
  const listing = { [deb]: ["a.deb", "notes.txt"], [rpm]: ["a.rpm"] };
  assert.deepEqual(previewPackages((path) => listing[path]), [join(deb, "a.deb"), join(rpm, "a.rpm")]);
  assert.throws(() => previewPackages((path) => (path.endsWith("deb") ? ["a.deb", "b.deb"] : ["a.rpm"])), /exactly one \.deb/);
  assert.throws(() => previewPackages((path) => (path.endsWith("deb") ? ["a.deb"] : [])), /exactly one \.rpm/);
});

test("the release is a pre-release that never becomes Latest", () => {
  const args = releaseArguments(previewIdentity(env, "1.2.3"),
    { packages: ["x.deb", "x.rpm"], checksumFile: "SHA256SUMS.txt", notesFile: "notes.md" });
  assert.deepEqual(args.slice(0, 6), ["release", "create", "linux-preview-1.2.3", "x.deb", "x.rpm", "SHA256SUMS.txt"]);
  assert.ok(args.includes("--prerelease"));
  assert.ok(args.includes("--latest=false"));
  assert.ok(!args.includes("--latest"));
  assert.equal(args[args.indexOf("--target") + 1], sha);
});

test("the notes say what the build is, how to install it and what it does", () => {
  const notes = previewNotes({ ...previewIdentity(env, "1.2.3"), files });
  assert.match(notes, /has not run on a physical Linux PC yet/);
  assert.match(notes, /sudo apt install \.\/nvstraps-rebar_1\.2\.3_amd64\.deb/);
  assert.match(notes, /sudo dnf install \.\/nvstraps-rebar-1\.2\.3-1\.x86_64\.rpm/);
  assert.match(notes, /never flashes a BIOS/);
  assert.match(notes, new RegExp(`${"a".repeat(64)}  nvstraps-rebar_1\\.2\\.3_amd64\\.deb`));
  assert.match(notes, new RegExp(`/blob/${sha}/docs/LINUX\\.md`));
  assert.equal(checksumLines(files), `${"a".repeat(64)}  ${files[0].name}\n${"b".repeat(64)}  ${files[1].name}\n`);
});

test("the workflow that publishes the preview is manual and builds on the oldest supported Ubuntu", () => {
  const workflow = readFileSync(new URL("../.github/workflows/LinuxPreview.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const triggers = workflow.split("\non:\n")[1]?.split(/\n\S/)[0] ?? "";
  assert.equal(triggers.trim(), "workflow_dispatch:", "nothing but a person starts a preview");
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.match(workflow, /npm run check:linux-packages -- --install/, "the packages are checked before they are published");
  const validation = readFileSync(new URL("../.github/workflows/Tauri.yml", import.meta.url), "utf8");
  assert.match(validation.split("native-linux:")[1].split("\n  real-app:")[0], /runs-on: ubuntu-22\.04/,
    "pull requests build the packages on the same Ubuntu as the preview");
});
