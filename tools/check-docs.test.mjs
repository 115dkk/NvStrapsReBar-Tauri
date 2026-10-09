import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { brokenLinks, issueFormProblems, linkTargets, resolveLink } from "./check-docs.mjs";

test("collects inline, image, reference and HTML targets but nothing inside code", () => {
  const markdown = [
    "See [the port](docs/RUST_UEFI_PORT.md#ovmf) and ![logo](rebar.png \"Logo\").",
    "[I39]: https://github.com/115dkk/NvStrapsReBar-Tauri/issues/39",
    "[local]: <docs/a b.md>",
    "<img src=\"docs/shot.png\" alt=\"shot\">",
    "`[not](inline.md)`",
    "```",
    "[not](fenced.md)",
    "```",
  ].join("\n");
  assert.deepEqual(linkTargets(markdown).sort(), [
    "docs/RUST_UEFI_PORT.md#ovmf",
    "docs/a b.md",
    "docs/shot.png",
    "https://github.com/115dkk/NvStrapsReBar-Tauri/issues/39",
    "rebar.png",
  ]);
});

test("resolves relative, root-relative and encoded links, and skips URLs and anchors", () => {
  assert.equal(resolveLink("docs/releases/v1.0.1.md", "../FLASHER_COMPATIBILITY.md#msi"), "docs/FLASHER_COMPATIBILITY.md");
  assert.equal(resolveLink("README.md", "/SECURITY.md"), "SECURITY.md");
  assert.equal(resolveLink("README.md", "docs/My%20Notes.md?plain=1"), "docs/My Notes.md");
  assert.equal(resolveLink("docs/x.md", "./"), "docs");
  assert.equal(resolveLink("docs/x.md", "../"), ".");
  assert.equal(resolveLink("README.md", "https://example.com/a.md"), null);
  assert.equal(resolveLink("README.md", "mailto:someone@example.com"), null);
  assert.equal(resolveLink("README.md", "//cdn.example.com/a.png"), null);
  assert.equal(resolveLink("README.md", "#current-status"), null);
});

test("reports a link to a missing file and accepts files, directories and the root", () => {
  const files = ["README.md", "docs/guide.md", "docs/img/a.png", "SECURITY.md"];
  const texts = {
    "README.md": "[guide](docs/guide.md) [images](docs/img/) [gone](docs/removed.md) [root](./)",
    "docs/guide.md": "![a](img/a.png) [up](../SECURITY.md) [typo](../SECURTY.md)",
    "SECURITY.md": "[web](https://example.com)",
  };
  assert.deepEqual(brokenLinks(files, (file) => texts[file]), [
    { file: "README.md", target: "docs/removed.md" },
    { file: "docs/guide.md", target: "../SECURTY.md" },
  ]);
});

test("finds missing keys, unknown field types and duplicate ids in an issue form", () => {
  const form = [
    "name: Report",
    "body:",
    "  - type: input",
    "    id: board",
    "  - type: textbox",
    "    id: board",
  ].join("\n");
  assert.deepEqual(issueFormProblems("f.yml", form), [
    'f.yml: the top-level "description" key is missing',
    'f.yml: unknown field type "textbox"',
    'f.yml: the field id "board" is used twice',
  ]);
});

test("the checked-in issue forms pass", () => {
  const directory = new URL("../.github/ISSUE_TEMPLATE/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/i.test(file) && !/^config\./i.test(file))) {
    assert.deepEqual(issueFormProblems(name, readFileSync(new URL(name, directory), "utf8")), []);
  }
});
