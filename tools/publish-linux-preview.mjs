import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { manifestVersion } from "./release-plan.mjs";

/**
 * Publishes the Linux packages as a GitHub pre-release of their own, from the manually started
 * Linux preview workflow that built and checked them.
 *
 * It is separate from the stable release on purpose. The stable release is Windows, is published
 * by `tools/publish-release.mjs` on a master push and is the repository's Latest release. The
 * maintainers have not run the Linux build on a physical PC, so it goes out as a pre-release that
 * never becomes Latest. Its tag does not start with "v": `tools/release-plan.mjs` takes the newest
 * `v<version>` tag as its baseline and must not see this one.
 *
 * The .rpm is published only with a signature that verifies against the project's public key
 * (docs/RPM-GPG-KEY-nvstraps-rebar), and that key is published beside it.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;
const BUNDLES = "target/release/bundle";
const OUTPUT = "target/linux-preview";
const PUBLIC_KEY = "docs/RPM-GPG-KEY-nvstraps-rebar";

export function previewIdentity(env, version) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repo } = env;
  if (event !== "workflow_dispatch" || ref !== "refs/heads/master") {
    throw new Error("The Linux preview is only published by hand from master.");
  }
  if (!SEMVER.test(version ?? "")) {
    throw new Error(`The manifest version "${version}" is not <major>.<minor>.<patch>.`);
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
    throw new Error("Missing or invalid GitHub release identity.");
  }
  return { version, tag: `linux-preview-${version}`, sha, repo };
}

/** The one package of each kind the build wrote; anything else means a stale or failed build. */
export function previewPackages(listDirectory = (path) => readdirSync(path)) {
  const only = (directory, extension) => {
    const found = listDirectory(join(BUNDLES, directory)).filter((name) => name.endsWith(extension));
    if (found.length !== 1) {
      throw new Error(`Expected exactly one ${extension} under ${BUNDLES}/${directory}, found ${found.length}.`);
    }
    return join(BUNDLES, directory, found[0]);
  };
  return [only("deb", ".deb"), only("rpm", ".rpm")];
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

export function previewNotes({ version, tag, sha, repo, files, fingerprint }) {
  const deb = files.find(({ name }) => name.endsWith(".deb")).name;
  const rpm = files.find(({ name }) => name.endsWith(".rpm")).name;
  return `**A preview for testers.** One user has reported a complete run of the 1.1.5 preview on a physical PC ([issue #63](https://github.com/${repo}/issues/63)); the maintainers have not run it on one themselves. The stable release is the Windows build under Latest.

Built from [\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha}), the same source as Windows ${version}. [docs/LINUX.md](https://github.com/${repo}/blob/${sha}/docs/LINUX.md) describes how the Linux build works and what has been proven.

## Install

| System | Command |
| --- | --- |
| Ubuntu 22.04 or later, Debian 12 or later | \`sudo apt install ./${deb}\` |
| Fedora and other RPM systems | \`sudo dnf install ./${rpm}\` |

You can add the project's repository instead, for \`apt\` on Debian and Ubuntu or for \`dnf\` on Fedora, and the package manager then offers each new preview with the system's other updates: ${repositoryAddress(repo)} shows the commands.

The \`.rpm\` is signed with the project's key, \`RPM-GPG-KEY-nvstraps-rebar\` among the files below (fingerprint \`${fingerprint}\`). \`dnf\` installs a local file without checking its signature. To check it, or to install with \`rpm -i\` where rpm insists on a signature it knows (RPM 6), import the key first:

\`\`\`
sudo rpm --import https://github.com/${repo}/releases/download/${tag}/RPM-GPG-KEY-nvstraps-rebar
rpm --checksig ${rpm}
\`\`\`

Start it from the application menu or with \`nvstraps-rebar\`. The \`.deb\` was installed and started on Ubuntu before it was published. The \`.rpm\` was inspected and its signature verified there, but it was not installed.

## What it does on your PC

- Opening the app only reads: NVIDIA GPUs and their BAR sizes, the board and BIOS identity, the two NvStrapsReBar firmware variables, and \`nvidia-smi\`.
- "Grant administrator rights" opens the system's password dialog and starts a small helper as root. That helper can do one thing: write or delete the \`NvStrapsReBar\` variable. It writes only when you save settings.
- The app never flashes a BIOS. It prepares a file; installing it stays your own step with the board's own updater. A BIOS update that fails can need a hardware programmer to recover, so keep a backup of the chip's current contents.
- A restart is requested only after you confirm it, as your own user, and is never forced.

Per-game settings and the route that leaves the BIOS alone are not in the Linux build.

## What helps most

Open the app and attach a screenshot of the first screen to [issue #63](https://github.com/${repo}/issues/63), with your distribution and version, NVIDIA driver version, and whether the session is Wayland or X11. If the window does not appear, start \`nvstraps-rebar\` in a terminal and attach what it prints.

## Checksums (SHA-256)

\`\`\`
${checksumLines(files).trimEnd()}
\`\`\`
`;
}

export function releaseArguments({ version, tag, sha, repo }, { packages, checksumFile, publicKey, notesFile }) {
  // `gh release create` refuses an existing tag's release, so a rerun never replaces one.
  return ["release", "create", tag, ...packages, checksumFile, publicKey,
    "--repo", repo, "--target", sha, "--prerelease", "--latest=false",
    "--title", `NvStrapsReBar ${version} for Linux (preview)`,
    "--notes-file", notesFile];
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main(env = process.env) {
  const identity = previewIdentity(env, manifestVersion());
  const packages = previewPackages();
  for (const file of packages) {
    if (!statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`Package is empty or missing: ${file}`);
    }
  }
  const existing = spawnSync("gh", ["release", "view", identity.tag, "--repo", identity.repo], { stdio: "ignore" });
  if (existing.status === 0) {
    throw new Error(`${identity.tag} is already published; a preview is published once per version.`);
  }
  // rpm on Fedora refuses a package without a signature, so one is never published.
  execFileSync("bash", ["scripts/check-rpm-signature.sh", packages[1], PUBLIC_KEY], { stdio: "inherit" });
  const fingerprint = keyFingerprint(readFileSync(PUBLIC_KEY, "utf8"));
  const files = packages.map((path) => ({ name: basename(path), sha256: sha256(path) }));
  mkdirSync(OUTPUT, { recursive: true });
  const checksumFile = join(OUTPUT, "SHA256SUMS.txt");
  const notesFile = join(OUTPUT, "notes.md");
  writeFileSync(checksumFile, checksumLines(files));
  writeFileSync(notesFile, previewNotes({ ...identity, files, fingerprint }));
  execFileSync("gh", releaseArguments(identity, { packages, checksumFile, publicKey: PUBLIC_KEY, notesFile }),
    { stdio: "inherit" });
  console.log(`Published ${identity.tag} from ${identity.sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
