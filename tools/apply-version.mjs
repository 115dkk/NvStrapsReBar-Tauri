import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Writes one version into every manifest that carries it, then lets cargo re-sync Cargo.lock.
 *
 * The files are the ones `tools/publish-release.mjs` commits as the release bump: package.json,
 * package-lock.json, src-tauri/tauri.conf.json, every workspace member's Cargo.toml, Cargo.lock,
 * and the installer's default version. Each rewrite is a targeted replacement so the files keep
 * their formatting.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;

export const MANIFESTS = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "installer/NvStrapsReBar.iss",
];

export function workspaceMembers(rootCargoToml) {
  const members = rootCargoToml.match(/^members = \[(?<list>[^\]]*)\]/m)?.groups.list ?? "";
  return [...members.matchAll(/"([^"]+)"/g)].map((match) => `${match[1]}/Cargo.toml`);
}

function replaceOnce(text, pattern, replacement, file) {
  if (!pattern.test(text)) {
    throw new Error(`${file} has no version field to update`);
  }
  return text.replace(pattern, replacement);
}

/** Rewrites the manifests in `files` (path -> text) and returns the new texts. */
export function rewriteManifests(version, files) {
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not <major>.<minor>.<patch>`);
  }
  const out = new Map();
  for (const [file, text] of files) {
    if (file === "package.json" || file === "src-tauri/tauri.conf.json") {
      out.set(file, replaceOnce(text, /^(\s*"version": )"[^"]+"(,?)$/m, `$1"${version}"$2`, file));
    } else if (file === "package-lock.json") {
      // The root entry and the "" package entry both carry the version, at the top of the file.
      const lines = text.split("\n");
      let replaced = 0;
      for (let index = 0; index < lines.length && replaced < 2; index += 1) {
        if (/^\s*"version": "[^"]+",?$/.test(lines[index])) {
          lines[index] = lines[index].replace(/"version": "[^"]+"/, `"version": "${version}"`);
          replaced += 1;
        }
      }
      if (replaced !== 2) {
        throw new Error(`${file} does not carry the two root version fields`);
      }
      out.set(file, lines.join("\n"));
    } else if (file.endsWith("Cargo.toml")) {
      out.set(file, replaceOnce(text, /^version = "[^"]+"$/m, `version = "${version}"`, file));
    } else if (file.endsWith(".iss")) {
      let next = replaceOnce(text, /^(\s*#define AppVersion )"[^"]+"$/m, `$1"${version}"`, file);
      next = next.replace(/AppVersion=\d+\.\d+\.\d+/g, `AppVersion=${version}`);
      next = next.replace(/AppVersion defaults to \d+\.\d+\.\d+/, `AppVersion defaults to ${version}`);
      out.set(file, next);
    } else {
      throw new Error(`${file} is not a manifest this tool knows`);
    }
  }
  return out;
}

export function applyVersion(version, { readFile = (p) => readFileSync(p, "utf8"), writeFile = writeFileSync, exec = execFileSync } = {}) {
  const members = workspaceMembers(readFile("Cargo.toml"));
  const paths = [...MANIFESTS, ...members];
  const files = new Map(paths.map((path) => [path, readFile(path)]));
  const rewritten = rewriteManifests(version, files);
  const changed = [];
  for (const [path, text] of rewritten) {
    if (text !== files.get(path)) {
      writeFile(path, text, "utf8");
      changed.push(path);
    }
  }
  if (changed.some((path) => path.endsWith("Cargo.toml"))) {
    // Re-syncs the workspace members' versions in Cargo.lock without touching dependencies.
    exec("cargo", ["update", "--workspace"], { stdio: "inherit" });
    changed.push("Cargo.lock");
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    throw new Error("usage: node tools/apply-version.mjs <major>.<minor>.<patch>");
  }
  const changed = applyVersion(version);
  console.log(changed.length ? `Version ${version} written to:\n${changed.map((f) => `- ${f}`).join("\n")}` : `Every manifest already carries ${version}.`);
}
