# Repository agent instructions

`AGENT.md` is the canonical repository working agreement. This plural-name shim exists so
Codex-compatible agents discover it automatically. Before changing this repository, read and
follow [`AGENT.md`](AGENT.md) and [`CONTEXT.md`](CONTEXT.md) in full.

- Unless the user gives an explicit keeping instruction such as local-only, no-push, PR-only, or
  no-merge, carry repository changes through merge, post-merge CI, and local default-branch sync.

For documentation or English gallery-only work, use the documented `doc`, `docs`, `gallery`,
`capture`, or `screenshot` PR/commit marker. The canonical agreement requires the CI scope
classifier to verify that every changed path is safe before it skips build and lint jobs.
