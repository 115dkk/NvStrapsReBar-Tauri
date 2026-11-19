import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { manifestVersion } from "./release-plan.mjs";
import {
  checksumLines, commandText, keyFingerprint, releaseArguments, releaseDownloads, releaseIdentity, releaseNotes,
  repositoryAddress,
} from "./publish-release.mjs";

const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master",
  GITHUB_SHA: "b".repeat(40), GITHUB_REPOSITORY: "115dkk/NvStrapsReBar-Tauri", RELEASE_VERSION: "1.0.1" };
const target = "c".repeat(40);
const handedOver = ["NvStrapsReBar-windows-x64-setup.exe", "NvStrapsReBar-windows-x64.zip",
  "nvstraps-rebar-1.0.1-1.x86_64.rpm", "nvstraps-rebar_1.0.1_amd64.deb"];
const files = [
  { name: "NvStrapsReBar-windows-x64.zip", sha256: "a".repeat(64) },
  { name: "NvStrapsReBar-windows-x64-setup.exe", sha256: "b".repeat(64) },
  { name: "nvstraps-rebar_1.0.1_amd64.deb", sha256: "c".repeat(64) },
  { name: "nvstraps-rebar-1.0.1-1.x86_64.rpm", sha256: "d".repeat(64) },
];

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

/** Workflow text with LF endings, so a CRLF checkout reads the same as CI. */
const workflowText = (file) => read(`.github/workflows/${file}`);

/** The lines of one top-level job, up to the next job. */
const jobText = (workflow, job) => workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0] ?? "";

/** Asserts that the steps appear in the text in this order. */
function assertOrder(text, steps, message) {
  const order = steps.map((step) => text.indexOf(step));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), `${message}: ${order}`);
}

test("publishes the bump commit as the latest release with the files of both systems", () => {
  const identity = releaseIdentity(env);
  assert.deepEqual(identity, { version: "1.0.1", tag: "v1.0.1", sha: env.GITHUB_SHA, repo: env.GITHUB_REPOSITORY });
  const attached = ["release-files/a.zip", "release-files/a.deb", "release-files/SHA256SUMS.txt", "KEY"];
  const args = releaseArguments(identity, { target, files: attached, notesFile: "notes.md", generateNotes: true });
  assert.equal(args[2], "v1.0.1");
  assert.deepEqual(args.slice(3, 7), attached);
  assert.equal(args[args.indexOf("--target") + 1], target);
  assert.equal(args[args.indexOf("--title") + 1], "NvStrapsReBar 1.0.1");
  assert.equal(args[args.indexOf("--notes-file") + 1], "notes.md");
  assert.ok(args.includes("--latest"));
  assert.ok(args.includes("--generate-notes"));
  assert.ok(!args.includes("--prerelease"));
  assert.ok(!args.includes("--clobber"));
  const written = releaseArguments(identity, { target, files: attached, notesFile: "notes.md", generateNotes: false });
  assert.ok(!written.includes("--generate-notes"), "checked-in notes are not followed by GitHub's list");
});

test("rejects branches, pull requests, bad versions and malformed identity", () => {
  for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_REF: "refs/tags/v1.0.1" }, { RELEASE_VERSION: "1.0" },
    { RELEASE_VERSION: "v1.0.1" }, { RELEASE_VERSION: "" }, { GITHUB_SHA: "master" }, { GITHUB_REPOSITORY: "--bad" }]) {
    assert.throws(() => releaseIdentity({ ...env, ...patch }), JSON.stringify(patch));
  }
});

test("a release needs the two Windows files and one package of each Linux kind, and nothing else", () => {
  assert.deepEqual(releaseDownloads(() => handedOver), [
    "release-files/NvStrapsReBar-windows-x64.zip",
    "release-files/NvStrapsReBar-windows-x64-setup.exe",
    "release-files/nvstraps-rebar_1.0.1_amd64.deb",
    "release-files/nvstraps-rebar-1.0.1-1.x86_64.rpm",
  ]);
  const without = (name) => () => handedOver.filter((file) => file !== name);
  assert.throws(releaseDownloads.bind(null, without("NvStrapsReBar-windows-x64.zip")), /no NvStrapsReBar-windows-x64\.zip/);
  assert.throws(releaseDownloads.bind(null, without("NvStrapsReBar-windows-x64-setup.exe")), /no NvStrapsReBar-windows-x64-setup\.exe/);
  assert.throws(releaseDownloads.bind(null, without("nvstraps-rebar_1.0.1_amd64.deb")), /exactly one \.deb/);
  assert.throws(releaseDownloads.bind(null, without("nvstraps-rebar-1.0.1-1.x86_64.rpm")), /exactly one \.rpm/);
  assert.throws(() => releaseDownloads(() => [...handedOver, "old_1.0.0_amd64.deb"]), /exactly one \.deb/);
  assert.throws(() => releaseDownloads(() => [...handedOver, "SHA256SUMS.txt"]), /not part of a release: SHA256SUMS\.txt/);
});

test("the notes say how to install each download and list every checksum", () => {
  const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  const notes = releaseNotes({ ...releaseIdentity(env), target, files, fingerprint, written: null });
  assert.match(notes, /^## Install\n/);
  assert.match(notes, /Run `NvStrapsReBar-windows-x64-setup\.exe`/);
  assert.match(notes, /sudo apt install \.\/nvstraps-rebar_1\.0\.1_amd64\.deb/);
  assert.match(notes, /sudo dnf install \.\/nvstraps-rebar-1\.0\.1-1\.x86_64\.rpm/);
  assert.ok(notes.includes("sudo rpm --import https://github.com/115dkk/NvStrapsReBar-Tauri/releases/download/"
    + "v1.0.1/RPM-GPG-KEY-nvstraps-rebar"), "the key is imported from this release's own files");
  assert.ok(notes.includes(`fingerprint \`${fingerprint}\``));
  assert.ok(notes.includes("https://115dkk.github.io/NvStrapsReBar-Tauri/ shows the commands"), "the notes point to the repositories");
  assert.match(notes, /for `apt` on Debian and Ubuntu or for `dnf` on Fedora/, "the notes name both repositories");
  assert.match(notes, new RegExp(`/blob/${target}/docs/LINUX\\.md`), "the Linux page is linked at the released commit");
  assert.ok(!/preview/i.test(notes), "the Linux build is not called a preview");
  assert.ok(notes.includes(checksumLines(files).trimEnd()));
  assert.equal(checksumLines(files.slice(2)),
    `${"c".repeat(64)}  ${files[2].name}\n${"d".repeat(64)}  ${files[3].name}\n`);

  const withText = releaseNotes({ ...releaseIdentity(env), target, files, fingerprint,
    written: "# NvStrapsReBar 1.0.1\n\nWhat changed.\n\n" });
  assert.match(withText, /^# NvStrapsReBar 1\.0\.1\n\nWhat changed\.\n\n## Install\n/, "checked-in notes come first");
});

test("the checked-in release notes for the manifest version start with the release heading", () => {
  const version = manifestVersion();
  const notes = `docs/releases/v${version}.md`;
  if (existsSync(notes)) {
    assert.match(readFileSync(notes, "utf8"), new RegExp(`^# NvStrapsReBar ${version.replaceAll(".", "\\.")}`, "m"));
  }
});

test("a master push only releases: the plan gates on the pull request, both systems build, then one job publishes", () => {
  const workflow = workflowText("Release.yml");
  assert.match(workflow, /\non:\n {2}push:\n {4}branches: \["master"\]\n\n/, "only master pushes start a release");
  assert.ok(!workflow.includes("pull_request:") && !workflow.includes("tags:") && !workflow.includes("workflow_dispatch"));
  assert.match(workflow, /group: master-release\n {2}cancel-in-progress: false/);
  const plan = jobText(workflow, "plan");
  assert.match(plan, /node tools\/release-plan\.mjs/);
  assert.match(plan, /if: steps\.release\.outputs\.release == 'true'\n(?:.*\n)*? {8}run: node tools\/release-gate\.mjs/);
  assert.match(plan, /actions: read/);
  assert.match(plan, /pull-requests: read/);

  const windows = jobText(workflow, "windows");
  const linux = jobText(workflow, "linux");
  const publish = jobText(workflow, "publish");
  for (const [name, job] of [["windows", windows], ["linux", linux]]) {
    assert.match(job, /needs: plan\n {4}if: needs\.plan\.outputs\.release == 'true'/, `${name} builds only for a release`);
    assert.ok(!job.includes("contents: write"), `${name} cannot push or publish`);
    assert.ok(!job.includes("publish-release"), `${name} does not publish`);
    assert.match(job, /retention-days: 1/, `${name} hands its files over for a day only`);
  }
  for (const [name, job] of [["windows", windows], ["linux", linux], ["publish", publish]]) {
    assert.match(job, /node tools\/apply-version\.mjs \$\{\{ needs\.plan\.outputs\.release-version \}\}/,
      `${name} writes the release version, so all three work on the same tree`);
  }
  assertOrder(windows, ["node tools/apply-version.mjs", "npm run build:firmware", "npm run tauri:ci",
    "scripts/build-installer.ps1", "actions/upload-artifact"], "Windows builds from the versioned tree, then hands over");
  assert.match(linux, /runs-on: ubuntu-22\.04/, "the packages are built on the oldest supported Ubuntu");
  assertOrder(linux, ["Require the rpm signing key", "node tools/apply-version.mjs", "npm run build:linux-packages",
    "bash scripts/sign-linux-rpm.sh", "npm run check:linux-packages -- --install", "actions/upload-artifact"],
  "the key is asked for first, the rpm is signed between the build and the check, and only checked packages are handed over");
  assert.deepEqual(linux.split("\n      - ").filter((step) => step.includes("secrets.NVSTRAPS_RPM_SIGNING_KEY"))
    .map((step) => step.split("\n")[0]),
  ["name: Require the rpm signing key", "name: Sign the rpm with the project key and verify the signature"],
  "only the step that signs is given the key, after the step that asks for it");

  assert.match(publish, /needs: \[plan, windows, linux\]/, "nothing is published unless both builds succeeded");
  assert.match(publish, /contents: write/);
  assertOrder(publish, ["node tools/apply-version.mjs", "actions/download-artifact", "node tools/publish-release.mjs"],
    "the publish job receives both builds before it commits and publishes");
  assert.ok(!publish.includes("NVSTRAPS_"), "the publish job holds no signing key");
  assert.match(jobText(workflow, "repository"), /needs: publish\n[\s\S]*uses: \.\/\.github\/workflows\/LinuxRepository\.yml/,
    "a new release is followed by new repositories");

  for (const check of ["cargo test", "cargo clippy", "cargo fmt", "npm run check\n", "test:e2e", "check:riir"]) {
    assert.ok(!workflow.includes(check), `the release does not run ${check.trim()} again`);
  }
  assert.ok(!workflow.includes("publish-prerelease") && !workflow.includes("--prerelease"));
  assert.ok(!existsSync(new URL("../.github/workflows/LinuxPreview.yml", import.meta.url)),
    "the Linux build has no release workflow of its own");
});

test("the Tauri workflow validates pull requests, with a docs job that runs whatever the scope", () => {
  const workflow = workflowText("Tauri.yml");
  assert.ok(!workflow.includes("release-plan") && !workflow.includes("publish-release"), "validation never releases");
  const docs = jobText(workflow, "docs");
  assert.ok(docs, "a docs job exists");
  assert.ok(!docs.includes("needs:") && !docs.includes("if:"), "the docs job runs on every event, heavy or not");
  assert.match(docs, /npm run check:docs/);
  assert.match(docs, /npm run check:ci-scope/);
  assert.ok(!docs.includes("npm ci"), "the docs job needs no dependency install");
  assert.match(jobText(workflow, "native-windows"), /scripts\/build-installer\.ps1/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  for (const upload of workflow.split("uses: actions/upload-artifact").slice(1)) {
    assert.match(upload.split("- name")[0], /retention-days: 7/);
  }
  const linux = jobText(workflow, "native-linux");
  assert.match(linux, /runs-on: ubuntu-22\.04/, "pull requests build the packages on the same Ubuntu as the release");
  assert.match(linux, /npm run check:linux-packages -- --install/);
  for (const script of ["test-rpm-signing", "test-apt-repository", "test-dnf-repository"]) {
    assert.ok(linux.includes(`bash scripts/${script}.sh`),
      `pull requests prove ${script} with a key made for the run`);
  }
  assert.ok(!workflow.includes("NVSTRAPS_RPM_SIGNING_KEY"), "pull request builds are not given the project key");
});

test("the apt and dnf repositories are built from the published releases, signed in one step and then published", () => {
  const repository = workflowText("LinuxRepository.yml");
  assertOrder(repository, [
    "Require the package signing key",
    "gh release download",
    "bash scripts/build-apt-repository.sh target/repository-site docs/RPM-GPG-KEY-nvstraps-rebar",
    "bash scripts/build-dnf-repository.sh target/repository-site docs/RPM-GPG-KEY-nvstraps-rebar",
    "bash scripts/sign-apt-repository.sh target/repository-site",
    "bash scripts/sign-dnf-repository.sh target/repository-site",
    "actions/upload-pages-artifact",
    "actions/deploy-pages",
  ], "the repositories are built from the published packages, signed, then published");
  assert.match(repository, /select\(\.draft \| not\) \| select\(any\(\.assets\[\]; \.name \| endswith\("\.deb"\)\)\)/,
    "every published release that carries a .deb is taken, whatever its tag");
  assert.match(repository, /--skip-existing/, "a package attached to two releases is taken once");
  const withKey = repository.split("\n      - ").filter((step) => step.includes("secrets.NVSTRAPS_RPM_SIGNING_KEY"));
  assert.deepEqual(withKey.map((step) => step.split("\n")[0]), [
    "name: Require the package signing key",
    "name: Sign the repositories with the project key and check them with apt and dnf",
  ], "only the step that signs is given the key, after the step that asks for it");
  assert.match(repository, /if: github\.ref == 'refs\/heads\/master'/, "only master publishes the repositories");

  // The page users copy the commands from names the same address and key as the documentation.
  const page = read("scripts/repository-site/index.html");
  const linux = read("docs/LINUX.md");
  const address = repositoryAddress("115dkk/NvStrapsReBar-Tauri");
  assert.equal(address, "https://115dkk.github.io/NvStrapsReBar-Tauri/");
  const fingerprint = keyFingerprint(read("docs/RPM-GPG-KEY-nvstraps-rebar"));
  assert.ok(page.includes(fingerprint.match(/.{4}/g).join(" ")), "the page shows the key's fingerprint");
  // The suite keeps the name it was first published under: apt stops updating when a repository
  // it already knows changes its suite or label.
  const source = `deb [arch=amd64 signed-by=/etc/apt/keyrings/nvstraps-rebar.asc] ${address}apt preview main`;
  for (const [name, text] of [["the page", page], ["docs/LINUX.md", linux]]) {
    assert.ok(text.includes(source), `${name} gives the apt source line`);
    assert.ok(text.includes(`${address}apt/nvstraps-rebar.asc`), `${name} gives the key's address`);
  }
  for (const script of ["build", "sign", "check"]) {
    assert.match(read(`scripts/${script}-apt-repository.sh`), /readonly SUITE="preview"/, `${script} uses the suite the source line names`);
  }
  assert.match(read("scripts/build-apt-repository.sh"), /Release::Label=NvStrapsReBar Linux preview"/,
    "the label apt users already accepted is unchanged");

  // The file dnf users download names that address, its own key, and asks for both signatures.
  const repoFile = read("scripts/repository-site/nvstraps-rebar.repo").split("\n");
  for (const line of [
    "[nvstraps-rebar]",
    `baseurl=${address}rpm`,
    `gpgkey=${address}rpm/RPM-GPG-KEY-nvstraps-rebar`,
    "gpgcheck=1",
    "repo_gpgcheck=1",
  ]) {
    assert.ok(repoFile.includes(line), `nvstraps-rebar.repo says ${line}`);
  }
  const fetch = `sudo curl -fsSL -o /etc/yum.repos.d/nvstraps-rebar.repo ${address}rpm/nvstraps-rebar.repo`;
  for (const [name, text] of [["the page", page], ["docs/LINUX.md", linux]]) {
    assert.ok(text.includes(fetch), `${name} gives the command that adds the dnf repository`);
  }
});

test("the published key is the project's key, and the documentation names it", () => {
  const key = readFileSync(new URL("../docs/RPM-GPG-KEY-nvstraps-rebar", import.meta.url), "utf8");
  // Users have imported this key, so replacing it is a decision and not a side effect.
  assert.equal(keyFingerprint(key), "F71DB90B8FF84EC454D42763FBA1244710950726");
  assert.equal(keyFingerprint(key.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")), keyFingerprint(key));
  const linux = readFileSync(new URL("../docs/LINUX.md", import.meta.url), "utf8");
  assert.ok(linux.includes(`\`${keyFingerprint(key)}\``), "docs/LINUX.md names the key by its fingerprint");
  assert.throws(() => keyFingerprint("not a key"), /armoured OpenPGP public key/);
});

test("a command that prints straight to the log, like the version push, yields empty text", () => {
  const inherited = execFileSync(process.execPath, ["-e", ""], { encoding: "utf8", stdio: "inherit" });
  assert.equal(inherited, null);
  assert.equal(commandText(inherited), "");
  assert.equal(commandText("0123abcd\r\n"), "0123abcd");
});
