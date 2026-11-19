import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { manifestVersion } from "./release-plan.mjs";

/**
 * Publishes the release for a master push: one release with the Windows files and the Linux
 * packages, from the job that received both builds.
 *
 * `tools/release-gate.mjs` has already tied the push to the pull request whose checks tested this
 * tree. The Windows job and the Linux job each built from that tree with the release version
 * written in, and handed their files to this job (`release-files/`). This checks them, commits
 * the version bump that `tools/apply-version.mjs` wrote (if anything changed), pushes that commit
 * to master, and creates the GitHub release as Latest with the files, their checksums and the
 * package key attached. A push made with the workflow token starts no new workflow run, so the
 * bump commit does not release itself.
 *
 * The .rpm is published only with a signature that verifies against the project's public key
 * (docs/RPM-GPG-KEY-nvstraps-rebar), and that key is published beside it.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;
const FILES = "release-files";
const WINDOWS_FILES = ["NvStrapsReBar-windows-x64.zip", "NvStrapsReBar-windows-x64-setup.exe"];
const PUBLIC_KEY = "docs/RPM-GPG-KEY-nvstraps-rebar";
const NOTES_OUTPUT = "target/release-notes.md";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export function releaseIdentity(env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo, RELEASE_VERSION: version } = env;
  if (event !== "push" || ref !== "refs/heads/master") {
    throw new Error("Releases are only published for pushes to master.");
  }
  if (!SEMVER.test(version ?? "")) {
    throw new Error(`RELEASE_VERSION "${version}" is not <major>.<minor>.<patch>.`);
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
    throw new Error("Missing or invalid GitHub release identity.");
  }
  return { version, tag: `v${version}`, sha, repo };
}

/**
 * The four downloads the two build jobs handed over: the Windows archive and installer, and one
 * package of each Linux kind. Anything missing or extra means a stale or failed build.
 */
export function releaseDownloads(listDirectory = (path) => readdirSync(path)) {
  const names = listDirectory(FILES);
  const only = (extension) => {
    const found = names.filter((name) => name.endsWith(extension));
    if (found.length !== 1) {
      throw new Error(`Expected exactly one ${extension} in ${FILES}, found ${found.length}.`);
    }
    return found[0];
  };
  const downloads = [...WINDOWS_FILES, only(".deb"), only(".rpm")];
  for (const name of WINDOWS_FILES) {
    if (!names.includes(name)) {
      throw new Error(`${FILES} has no ${name}.`);
    }
  }
  const extra = names.filter((name) => !downloads.includes(name));
  if (extra.length > 0) {
    throw new Error(`${FILES} holds files that are not part of a release: ${extra.join(", ")}.`);
  }
  return downloads.map((name) => `${FILES}/${name}`);
}

/**
 * The fingerprint of the first key in an ASCII-armoured OpenPGP public key: SHA-1 over the
 * version 4 key packet (RFC 4880, 12.2). Computed here so that the notes and the tests name the
 * key without gpg.
 */
export function keyFingerprint(armored) {
  const lines = armored.split(/\r?\n/);
  const begin = lines.indexOf("-----BEGIN PGP PUBLIC KEY BLOCK-----");
  const end = lines.indexOf("-----END PGP PUBLIC KEY BLOCK-----");
  if (begin < 0 || end < begin) {
    throw new Error("Not an armoured OpenPGP public key.");
  }
  // The armour headers end at the first empty line; the line that starts with "=" is a checksum.
  const body = lines.slice(begin + 1, end);
  const data = Buffer.from(
    body.slice(body.indexOf("") + 1).filter((line) => !line.startsWith("=")).join(""), "base64");
  const first = data[0] ?? 0;
  const oldFormat = (first & 0xc0) === 0x80;
  const tag = oldFormat ? (first >> 2) & 0x0f : first & 0x3f;
  let offset;
  let length;
  if (oldFormat && (first & 0x03) === 0) {
    [offset, length] = [2, data[1]];
  } else if (oldFormat && (first & 0x03) === 1) {
    [offset, length] = [3, data.readUInt16BE(1)];
  } else if (!oldFormat && (first & 0xc0) === 0xc0 && data[1] < 192) {
    [offset, length] = [2, data[1]];
  } else if (!oldFormat && (first & 0xc0) === 0xc0 && data[1] < 224) {
    [offset, length] = [3, ((data[1] - 192) << 8) + data[2] + 192];
  }
  const packet = length == null ? null : data.subarray(offset, offset + length);
  if (tag !== 6 || !packet || packet.length !== length || packet[0] !== 4) {
    throw new Error("The file does not start with a version 4 OpenPGP public key.");
  }
  return createHash("sha1")
    .update(Buffer.from([0x99, length >> 8, length & 0xff]))
    .update(packet)
    .digest("hex")
    .toUpperCase();
}

export function checksumLines(files) {
  return files.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n") + "\n";
}

/** Where GitHub Pages serves the apt and dnf repositories of `owner/name` (LinuxRepository.yml). */
export function repositoryAddress(repo) {
  const [owner, name] = repo.split("/");
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

/**
 * The release notes: the checked-in text for this version if there is one (docs/releases), then
 * how to install each download, then the checksums. GitHub's list of merged pull requests is
 * added by `gh release create` when no text was checked in.
 *
 * @param target the commit the release tag points at, which is the tree the files were built from.
 * @param files the downloads as `{ name, sha256 }`.
 */
export function releaseNotes({ tag, repo, target, files, fingerprint, written }) {
  const deb = files.find(({ name }) => name.endsWith(".deb")).name;
  const rpm = files.find(({ name }) => name.endsWith(".rpm")).name;
  const downloads = `## Install

**Windows x64.** Run \`NvStrapsReBar-windows-x64-setup.exe\`, which installs the app with Start menu and optional desktop shortcuts, or extract \`NvStrapsReBar-windows-x64.zip\` and keep \`NvStrapsReBar.exe\` and \`NvStrapsReBar.ffs\` together. Requires WebView2.

**Linux x86-64.**

| System | Command |
| --- | --- |
| Ubuntu 22.04 or later, Debian 12 or later | \`sudo apt install ./${deb}\` |
| Fedora and other RPM systems | \`sudo dnf install ./${rpm}\` |

You can add the project's repository instead, for \`apt\` on Debian and Ubuntu or for \`dnf\` on Fedora, and the package manager then offers each new version with the system's other updates: ${repositoryAddress(repo)} shows the commands. [docs/LINUX.md](https://github.com/${repo}/blob/${target}/docs/LINUX.md) describes what the Linux build does and what has been checked.

The \`.rpm\` is signed with the project's key, \`RPM-GPG-KEY-nvstraps-rebar\` among the files below (fingerprint \`${fingerprint}\`). \`dnf\` installs a local file without checking its signature. To check it, or to install with \`rpm -i\` where rpm insists on a signature it knows (RPM 6), import the key first:

\`\`\`
sudo rpm --import https://github.com/${repo}/releases/download/${tag}/RPM-GPG-KEY-nvstraps-rebar
rpm --checksig ${rpm}
\`\`\`

The \`.deb\` was installed and started on Ubuntu before it was published. The \`.rpm\` was inspected and its signature verified there, but it was not installed.

## Checksums (SHA-256)

\`\`\`
${checksumLines(files).trimEnd()}
\`\`\`
`;
  return written ? `${written.trimEnd()}\n\n${downloads}` : downloads;
}

/**
 * @param files the paths to attach, in the order the release lists them.
 * @param generateNotes whether GitHub adds its list of merged pull requests after the notes.
 */
export function releaseArguments({ version, tag, repo }, { target, files, notesFile, generateNotes }) {
  const args = ["release", "create", tag, ...files,
    "--repo", repo, "--target", target, "--latest",
    "--title", `NvStrapsReBar ${version}`, "--notes-file", notesFile];
  if (generateNotes) {
    args.push("--generate-notes");
  }
  // `gh release create` refuses an existing tag's release, so a rerun never replaces one.
  return args;
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options });
}

/**
 * The text a command printed. A command run with `stdio: "inherit"` writes straight to the job log
 * and execFileSync returns null for it, as the push of the version commit does.
 */
export function commandText(output) {
  return typeof output === "string" ? output.trim() : "";
}

function git(args, options = {}) {
  return commandText(execFileSync("git", args, { encoding: "utf8", ...options }));
}

/** The files tools/apply-version.mjs may have rewritten, and nothing else in the tree. */
const VERSION_FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json",
  "installer/NvStrapsReBar.iss", "Cargo.toml", "Cargo.lock", "crates", "src-tauri/Cargo.toml"];

/** Stages the version files and reports whether the index now differs from HEAD. */
function stageVersionFiles() {
  const status = git(["status", "--porcelain", "--", ...VERSION_FILES]);
  if (status) {
    console.log(`Working tree before staging:\n${status}`);
  }
  git(["add", "--", ...VERSION_FILES]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...VERSION_FILES], { encoding: "utf8" });
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`git diff --cached failed: ${diff.stderr}`);
  }
  return diff.status === 1;
}

function commitVersionBump(tag) {
  if (!stageVersionFiles()) {
    console.log("The manifests already carry the release version; nothing to commit.");
    return;
  }
  git(["config", "user.name", BOT_NAME]);
  git(["config", "user.email", BOT_EMAIL]);
  git(["commit", "-m", `Release ${tag}`, "-m",
    "Version bump written by the release workflow; the attached builds were made from this tree."]);
  // Fails on a non-fast-forward push, which means master moved on; the next push releases.
  git(["push", "origin", "HEAD:master"], { stdio: "inherit" });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main(env = process.env) {
  const identity = releaseIdentity(env);
  const found = manifestVersion();
  if (found !== identity.version) {
    throw new Error(`The manifests carry ${found}, not the release version ${identity.version}.`);
  }
  const downloads = releaseDownloads();
  for (const file of downloads) {
    if (!statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`Release file is empty or missing: ${file}`);
    }
  }
  // rpm on Fedora refuses a package without a signature, so one is never published.
  execFileSync("bash", ["scripts/check-rpm-signature.sh", downloads.find((file) => file.endsWith(".rpm")), PUBLIC_KEY],
    { stdio: "inherit" });
  const files = downloads.map((path) => ({ name: path.slice(FILES.length + 1), sha256: sha256(path) }));
  const checksumFile = `${FILES}/SHA256SUMS.txt`;
  writeFileSync(checksumFile, checksumLines(files));

  commitVersionBump(identity.tag);
  const target = git(["rev-parse", "HEAD"]);
  const writtenFile = `docs/releases/${identity.tag}.md`;
  const written = existsSync(writtenFile) ? readFileSync(writtenFile, "utf8") : null;
  mkdirSync("target", { recursive: true });
  writeFileSync(NOTES_OUTPUT, releaseNotes({ ...identity, target, files,
    fingerprint: keyFingerprint(readFileSync(PUBLIC_KEY, "utf8")), written }));
  gh(releaseArguments(identity, { target, files: [...downloads, checksumFile, PUBLIC_KEY],
    notesFile: NOTES_OUTPUT, generateNotes: written == null }), { stdio: "inherit" });
  console.log(`Published ${identity.tag} from ${target}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
