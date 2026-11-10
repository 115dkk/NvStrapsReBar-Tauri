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
 * Linux build has not run on a physical PC yet, so it goes out as a pre-release that never
 * becomes Latest. Its tag does not start with "v": `tools/release-plan.mjs` takes the newest
 * `v<version>` tag as its baseline and must not see this one.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;
const BUNDLES = "target/release/bundle";
const OUTPUT = "target/linux-preview";

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

export function checksumLines(files) {
  return files.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n") + "\n";
}

export function previewNotes({ version, sha, repo, files }) {
  const deb = files.find(({ name }) => name.endsWith(".deb")).name;
  const rpm = files.find(({ name }) => name.endsWith(".rpm")).name;
  return `**A preview for testers. It has not run on a physical Linux PC yet.** The stable release is the Windows build under Latest.

Built from [\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha}), the same source as Windows ${version}. [docs/LINUX.md](https://github.com/${repo}/blob/${sha}/docs/LINUX.md) describes how the Linux build works and what has been proven.

## Install

| System | Command |
| --- | --- |
| Ubuntu 22.04 or later, Debian 12 or later | \`sudo apt install ./${deb}\` |
| Fedora and other RPM systems | \`sudo dnf install ./${rpm}\` |

Start it from the application menu or with \`nvstraps-rebar\`. The \`.deb\` was installed and started on Ubuntu before it was published. The \`.rpm\` was only inspected, so treat it as untried.

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

export function releaseArguments({ version, tag, sha, repo }, { packages, checksumFile, notesFile }) {
  // `gh release create` refuses an existing tag's release, so a rerun never replaces one.
  return ["release", "create", tag, ...packages, checksumFile,
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
  const files = packages.map((path) => ({ name: basename(path), sha256: sha256(path) }));
  mkdirSync(OUTPUT, { recursive: true });
  const checksumFile = join(OUTPUT, "SHA256SUMS.txt");
  const notesFile = join(OUTPUT, "notes.md");
  writeFileSync(checksumFile, checksumLines(files));
  writeFileSync(notesFile, previewNotes({ ...identity, files }));
  execFileSync("gh", releaseArguments(identity, { packages, checksumFile, notesFile }), { stdio: "inherit" });
  console.log(`Published ${identity.tag} from ${identity.sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
