import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const nativeSource = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ixx)$/i;
const forbiddenPaths = new Set([
  ".clangd",
  "compile_commands.template.json",
  ".github/workflows/ReBarDxe.yml",
  ".github/workflows/buildffs.bat",
  ".github/workflows/buildffs.sh",
  "tools/uuidconv.py",
]);
const violations = tracked.filter(
  (path) =>
    nativeSource.test(path) ||
    path.startsWith("ReBarDxe/") ||
    path.startsWith("ReBarState/") ||
    forbiddenPaths.has(path),
);

if (violations.length !== 0) {
  process.stderr.write(
    `RIIR gate rejected superseded native/tooling files:\n${violations
      .map((path) => `- ${path}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RIIR gate passed: ${tracked.length} tracked files contain no C/C++ runtime or EDK2 build path.\n`,
);
