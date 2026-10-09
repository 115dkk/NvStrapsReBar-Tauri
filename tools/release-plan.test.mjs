import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpVersion,
  detectLevel,
  isProgramPath,
  manifestVersion,
  messageLevel,
  planRelease,
} from "./release-plan.mjs";

test("program paths are what ships; docs, CI, tests and test tooling are not", () => {
  for (const file of ["src/App.tsx", "src-tauri/src/lib.rs", "crates/nvstraps-ffs/src/lib.rs",
    "public/licenses/Pretendard/LICENSE", "index.html", "package.json", "package-lock.json",
    "Cargo.toml", "Cargo.lock", "installer/NvStrapsReBar.iss", "THIRD_PARTY_NOTICES.md", "LICENSE",
    "UEFIPatch/patches.txt", "vite.config.ts", "tsconfig.app.json"]) {
    assert.equal(isProgramPath(file), true, file);
  }
  for (const file of ["README.md", "README.ko.md", "AGENT.md", "docs/RUST_UEFI_PORT.md",
    "docs/releases/v1.0.0.md", "docs/frontend-gallery/home.png", ".github/workflows/Tauri.yml",
    ".github/ISSUE_TEMPLATE/bug-report.md", "tests/e2e/games.spec.ts", "tests/qemu/s3-cycle.nsh",
    "scripts/qemu-smoke.sh", "tools/release-plan.mjs", "crates/nvstraps-s3-probe/src/stub.rs",
    "src/i18n.test.ts", "playwright.config.ts", ".gitignore", "rebar.png"]) {
    assert.equal(isProgramPath(file), false, file);
  }
});

test("commit markers raise the level; ordinary prose does not", () => {
  assert.equal(messageLevel("feat: add a screen"), "minor");
  assert.equal(messageLevel("feat(games): add a switch"), "minor");
  assert.equal(messageLevel("minor: widen the catalog"), "minor");
  assert.equal(messageLevel("[minor] widen the catalog"), "minor");
  assert.equal(messageLevel("major: new config layout"), "major");
  assert.equal(messageLevel("breaking: drop the old variable"), "major");
  assert.equal(messageLevel("feat!: drop the old variable"), "major");
  assert.equal(messageLevel("Rework the layout\n\nBREAKING CHANGE: the variable moved"), "major");
  assert.equal(messageLevel("Add the feature flag the users asked for"), null);
  assert.equal(messageLevel("Fix a major annoyance in the minor settings"), null);
  assert.equal(messageLevel("docs: explain the feat"), null);
});

test("the level follows the changed paths and the strongest marker", () => {
  assert.equal(detectLevel({ files: ["README.md", "docs/a.md"], messages: ["feat: docs"] }).level, "none");
  assert.equal(detectLevel({ files: [".github/workflows/Tauri.yml", "tests/e2e/a.spec.ts", "crates/nvstraps-s3-probe/src/main.rs"], messages: [] }).level, "none");
  assert.equal(detectLevel({ files: ["src/App.tsx"], messages: ["Fix the focus ring"] }).level, "patch");
  assert.equal(detectLevel({ files: ["crates/nvstraps-uefi/src/s3.rs"], messages: [] }).level, "minor");
  assert.equal(detectLevel({ files: ["crates/nvstraps-core/src/config.rs"], messages: [] }).level, "minor");
  assert.equal(detectLevel({ files: ["src/App.tsx"], messages: ["feat: add a screen"] }).level, "minor");
  assert.equal(detectLevel({ files: ["crates/nvstraps-uefi/src/s3.rs"], messages: ["fix: typo", "major: new layout"] }).level, "major");
});

test("versions bump by level", () => {
  assert.deepEqual(bumpVersion([1, 2, 3], "patch"), [1, 2, 4]);
  assert.deepEqual(bumpVersion([1, 2, 3], "minor"), [1, 3, 0]);
  assert.deepEqual(bumpVersion([1, 2, 3], "major"), [2, 0, 0]);
  assert.deepEqual(bumpVersion([1, 2, 3], "none"), [1, 2, 3]);
});

const push = { eventName: "push", ref: "refs/heads/master" };

test("only master pushes with a program change release", () => {
  assert.equal(planRelease({ ...push, eventName: "pull_request", files: ["src/a.ts"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.0.0" }).release, false);
  assert.equal(planRelease({ ...push, ref: "refs/heads/feature", files: ["src/a.ts"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.0.0" }).release, false);
  assert.equal(planRelease({ ...push, files: ["README.md"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.0.0" }).release, false);
  assert.equal(planRelease({ ...push, files: ["src/a.ts"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.0" }).release, false);
});

test("the first release publishes the manifests' version; later ones bump the last tag", () => {
  const first = planRelease({ ...push, files: ["src/a.ts"], messages: [], latestTag: null, manifestVersion: "1.0.0" });
  assert.deepEqual([first.release, first.level, first.version, first.tag], [true, "patch", "1.0.0", "v1.0.0"]);
  const patch = planRelease({ ...push, files: ["src/a.ts"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.0.0" });
  assert.deepEqual([patch.version, patch.tag], ["1.0.1", "v1.0.1"]);
  const minor = planRelease({ ...push, files: ["crates/nvstraps-uefi/src/pci.rs"], messages: [], latestTag: "v1.0.4", manifestVersion: "1.0.4" });
  assert.equal(minor.version, "1.1.0");
  const major = planRelease({ ...push, files: ["src/a.ts"], messages: ["breaking: new variable layout"], latestTag: "v1.1.0", manifestVersion: "1.1.0" });
  assert.equal(major.version, "2.0.0");
});

test("a manual bump past the last tag is published as written", () => {
  const plan = planRelease({ ...push, files: ["src/a.ts"], messages: [], latestTag: "v1.0.0", manifestVersion: "1.2.0" });
  assert.deepEqual([plan.version, plan.tag], ["1.2.0", "v1.2.0"]);
  assert.match(plan.reason, /already moved past v1\.0\.0/);
});

test("the checked-in manifests agree on one semantic version", () => {
  assert.match(manifestVersion(), /^\d+\.\d+\.\d+$/);
  assert.throws(() => manifestVersion((path) => path === "package.json" ? '{"version":"9.9.9"}' : path.endsWith(".toml") ? 'version = "1.0.0"' : '{"version":"1.0.0"}'), /disagree/);
});
