import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  checksumLines, keyFingerprint, previewIdentity, previewNotes, previewPackages, releaseArguments, repositoryAddress,
} from "./publish-linux-preview.mjs";

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
    { packages: ["x.deb", "x.rpm"], checksumFile: "SHA256SUMS.txt", publicKey: "KEY", notesFile: "notes.md" });
  assert.deepEqual(args.slice(0, 7),
    ["release", "create", "linux-preview-1.2.3", "x.deb", "x.rpm", "SHA256SUMS.txt", "KEY"]);
  assert.ok(args.includes("--prerelease"));
  assert.ok(args.includes("--latest=false"));
  assert.ok(!args.includes("--latest"));
  assert.equal(args[args.indexOf("--target") + 1], sha);
});

test("the notes say what the build is, how to install it and what it does", () => {
  const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  const notes = previewNotes({ ...previewIdentity(env, "1.2.3"), files, fingerprint });
  assert.match(notes, /the maintainers have not run it on one themselves/);
  assert.match(notes, /sudo apt install \.\/nvstraps-rebar_1\.2\.3_amd64\.deb/);
  assert.match(notes, /sudo dnf install \.\/nvstraps-rebar-1\.2\.3-1\.x86_64\.rpm/);
  assert.ok(notes.includes("sudo rpm --import https://github.com/115dkk/NvStrapsReBar-Tauri/releases/download/"
    + "linux-preview-1.2.3/RPM-GPG-KEY-nvstraps-rebar"), "the key is imported from this release's own files");
  assert.ok(notes.includes(`fingerprint \`${fingerprint}\``));
  assert.ok(notes.includes("https://115dkk.github.io/NvStrapsReBar-Tauri/ shows the commands"), "the notes point to the apt repository");
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

test("the preview signs the rpm before it checks and publishes it, and pull requests never see the key", () => {
  const workflow = readFileSync(new URL("../.github/workflows/LinuxPreview.yml", import.meta.url), "utf8");
  const order = [
    "Require the rpm signing key",
    "npm run build:linux-packages",
    "bash scripts/sign-linux-rpm.sh",
    "npm run check:linux-packages -- --install",
    "node tools/publish-linux-preview.mjs",
  ].map((step) => workflow.indexOf(step));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
    `the key is asked for first and the rpm is signed between the build and the check: ${order}`);
  const validation = readFileSync(new URL("../.github/workflows/Tauri.yml", import.meta.url), "utf8");
  assert.match(validation.split("native-linux:")[1].split("\n  real-app:")[0], /bash scripts\/test-rpm-signing\.sh/,
    "pull requests prove the signing scripts with a key made for the run");
  assert.ok(!validation.includes("NVSTRAPS_RPM_SIGNING_KEY"), "pull request builds are not given the project key");
});

test("the apt repository is signed in one step, checked by pull requests without the key, and published after the preview", () => {
  const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const repository = read(".github/workflows/LinuxRepository.yml");
  const order = [
    "Require the package signing key",
    "gh release download",
    "bash scripts/build-apt-repository.sh target/apt-site docs/RPM-GPG-KEY-nvstraps-rebar",
    "bash scripts/sign-apt-repository.sh target/apt-site",
    "actions/upload-pages-artifact",
    "actions/deploy-pages",
  ].map((step) => repository.indexOf(step));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])),
    `the repository is built from the published previews, signed, then published: ${order}`);
  const steps = repository.split("\n      - ");
  const withKey = steps.filter((step) => step.includes("secrets.NVSTRAPS_RPM_SIGNING_KEY"));
  assert.deepEqual(withKey.map((step) => step.split("\n")[0]), [
    "name: Require the package signing key",
    "name: Sign the repository with the project key and check it with apt",
  ], "only the step that signs is given the key, after the step that asks for it");
  assert.match(repository, /if: github\.ref == 'refs\/heads\/master'/, "only master publishes the repository");

  const preview = read(".github/workflows/LinuxPreview.yml");
  assert.match(preview.split("\n  repository:")[1] ?? "", /needs: publish\n[\s\S]*uses: \.\/\.github\/workflows\/LinuxRepository\.yml/,
    "a new preview is followed by a new repository");
  const validation = read(".github/workflows/Tauri.yml");
  assert.match(validation.split("native-linux:")[1].split("\n  real-app:")[0], /bash scripts\/test-apt-repository\.sh/,
    "pull requests prove the repository scripts with a key made for the run");

  // The page users copy the commands from names the same address and key as the documentation.
  const page = read("scripts/apt-site/index.html");
  const address = repositoryAddress("115dkk/NvStrapsReBar-Tauri");
  assert.equal(address, "https://115dkk.github.io/NvStrapsReBar-Tauri/");
  const fingerprint = keyFingerprint(read("docs/RPM-GPG-KEY-nvstraps-rebar"));
  assert.ok(page.includes(fingerprint.match(/.{4}/g).join(" ")), "the page shows the key's fingerprint");
  const source = `deb [arch=amd64 signed-by=/etc/apt/keyrings/nvstraps-rebar.asc] ${address}apt preview main`;
  for (const [name, text] of [["the page", page], ["docs/LINUX.md", read("docs/LINUX.md")]]) {
    assert.ok(text.includes(source), `${name} gives the apt source line`);
    assert.ok(text.includes(`${address}apt/nvstraps-rebar.asc`), `${name} gives the key's address`);
  }
  for (const script of ["build", "sign", "check"]) {
    assert.match(read(`scripts/${script}-apt-repository.sh`), /readonly SUITE="preview"/, `${script} uses the suite the source line names`);
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
