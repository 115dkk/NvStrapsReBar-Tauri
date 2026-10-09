# Repository working agreement

Read `CONTEXT.md` before changing behavior. Its domain language and load-bearing invariants are
authoritative. Keep RIIR, deployment automation, and physical-machine proof as separate claims.

## Safety and truth

- Never overwrite the selected firmware image. All derived firmware and receipts are immutable,
  content-addressed outputs under an owned profile or export root.
- Never bypass a vendor signature, invoke an unpinned flasher, invent a board profile, weaken an
  exact-machine comparison, or turn a mismatch into a warning. The only controlled identity
  transitions are BIOS version/release date plus BAR0 before the first proven post-flash boot, and
  BAR0 alone across the later configuration reboot; each successful boot must immediately pin a
  new `BootObservation` and restore exact comparison.
- Do not execute a real EFI write, restart, flash, firmware-setting change, or hardware smoke test
  during development unless the user explicitly authorizes that exact consequential operation on
  the pinned machine. Test adapters and pure decision logic instead.
- A prepared artifact is not a flashed artifact. Opening firmware setup or an external tool is not
  completion. Accepting a restart request is not a completed restart.
- Keep `/f` out of every Windows restart command. Require saved-work confirmation immediately
  before a real restart request.
- Keep vendor flash, firmware settings, physical recovery, and hardware changes as manual gates.
  Present each gate as the user's next action (what to do, where, and how to record it), never as
  a disclaimer about what the app cannot do. Automate only evidence the owning system can actually
  prove.
- NVIDIA driver profiles change only on the user's switch. A game switch writes only that game's
  profile; the all-games switch writes the all-programs profile, and turning it on needs the
  user's consent in a dialog. Record each profile's own values before the app first changes it,
  and undo only those values, so an undo never rolls back a driver update or other NVIDIA
  settings. Also save a full copy of the database before the first change, never overwrite a copy,
  and show a state only after a new driver session reads it back. These are driver settings, not firmware: real writes are tested on a Windows PC with an
  NVIDIA driver from the handoff, while repository tests use the in-memory database and NVAPI
  stand-ins.
- A driver settings failure is never dropped silently. Return it, or skip and count it, but every
  failed NVAPI call, every write, and every skip leaves a line in the diagnostic log, and command
  errors carry the log path. Do not panic for a recoverable condition; release builds abort.
- Browser preview, Playwright, compilation, OVMF, and QEMU evidence must state their target. None
  of them proves a real vendor image, native dialog, WebView2 lifecycle, flash, reboot, or GPU.

## Architecture

- Repository-owned runtime and build functionality is Rust or TypeScript. Do not add C/C++, EDK2
  build descriptors, Python firmware builders, or a dependency on the deleted `ReBarState/` and
  `ReBarDxe/` trees. `npm run check:riir` is the enforced boundary.
- `MachineProfile` is immutable and exact. `DeploymentPlan` is ordered, append-only, and has one
  ready step. Do not mutate persisted JSON or reconstruct plan state in React.
- Route plan transitions through the Rust `DeploymentWorkflow` module. It must validate the active
  step, persist the next revision, and only then expose the new state.
- Keep Tauri commands as narrow adapters. Rust revalidates paths, profile identity, topology,
  privilege, active step, external-tool output, and consequential data even when the client did so.
- Evidence belongs to the owner of the claimed result. Preserve separate receipts for artifact
  preparation, manual attestation, current-boot DXE status, configuration readback, later boot,
  BAR1 observation, NVIDIA driver profile read-back, and the optional per-game record.
- Preserve camel-case wire compatibility across Rust serde types,
  `src/deployment-workspace/contract.ts`, the Tauri adapter, preview fixtures, and Playwright
  journeys. The deployment UI talks only to `DeploymentWorkspaceSession`; command names and
  request DTOs stay in the Tauri adapter. Preview may select immutable plan snapshots, but must
  not reimplement Rust transition policy. Every adapter must preserve stale-reply rejection,
  failure truth, confirmation binding, and revision semantics.

## Frontend ownership

- When the primary agent is Daybreak Blue, any change to a rendered screen, interaction,
  user-facing state/copy, layout, styling, or its bridge-driven journey must be delegated to a
  GPT-5.6 Sol sub-agent. This delegation requirement applies only to Daybreak Blue; Astra may
  implement and judge frontend changes directly.
- Explicitly activate and follow `superloopy:superloopy-frontend` for frontend work. The main
  agent reads the skill, constrains the Rust contract, reviews the result, runs final gates, and
  owns commits; a delegated Sol agent does not commit.
- User-facing copy says what the user does next and what the app just did for them. Do not list
  what the app does not do, cannot do, or has not verified. Those boundaries are enforced in Rust
  and documented for developers in this file, `CONTEXT.md`, and the README. Turn a limit into an
  action ("Install it with M-FLASH", "Prepare the recovery USB first") and state a real risk once,
  at the step where the user can act on it.
- The app does not converse with the user. It does not ask, tell, promise, pick things out or
  keep things ready as a favour ("한 번 더 묻습니다", "앱이 골라 두었습니다", "저장해 두었습니다"),
  labels do not speak as "I" ("내가 할 일"), and choices are instructions with options named as
  states, not questions answered by "있습니다". Use operational verbs (저장, 기록, 표시, 보고), not
  literary ones ("담습니다"). See `write.md` in the make-interfaces-feel-better skill.
- Any Korean UI copy must also follow `superloopy:humanize-korean`. Preserve technical facts and
  protected tokens, run its file-backed audit, and keep the resulting evidence with the frontend
  run receipt. When delegating, pass this requirement explicitly to the Sol frontend owner.
- Use a fresh `.superloopy/evidence/frontend/<run-id>/` for each logical frontend run. Visible or
  spatial changes require proportional `UX_CONTRACT.md`, `VISUAL_QA.md`, rendered Chromium
  captures, and helper verification. Record native and physical limitations explicitly.
- Preserve the established React/CSS design system, keyboard behavior, visible focus, modal focus
  containment and restoration, stale-response guards, duplicate-submit guards, and the supported
  minimum 900 px window. Exercise the affected journey at 1180x760 and the 900 px minimum.

## Commits and recovery

- Preserve unrelated user changes. Stage explicit paths only.
- Unless the user explicitly asks to keep the work local, stop before publishing, leave a PR
  unmerged, or otherwise names a narrower keeping boundary, repository changes are complete only
  after intentional commits, push, PR creation, required CI, merge, post-merge CI, and local
  default-branch synchronization all succeed.
- Make small, logical, reversible commits: one domain behavior, adapter, frontend journey,
  architecture refactor, documentation update, or CI change per commit. Do not hide unrelated work
  in a catch-all commit.
- Run the narrow relevant tests before each commit and report the evidence. Run broader gates after
  the sequence. Do not amend, squash, reset, or rewrite history unless the user asks.
- If an external side effect succeeds but plan persistence fails, keep retries idempotent and never
  claim the plan advanced. Add fault-injection coverage for such boundaries.

## Validation gates

### Documentation-only CI scope

- Prefix a documentation-only PR title or the final `master` commit message with `doc:`, `docs:`,
  `documentation:`, `gallery:`, `capture:`, or `screenshot:` (plural forms and bracketed markers
  are also accepted) when the heavy build and lint jobs should stop after scope classification.
- The marker is only a request. Heavy CI is skipped only when every changed path is a recognized
  repository document, issue template, or asset under `docs/`; code, workflow, bundled/public
  assets, legal notices, or any other path make the classifier fail closed and run every job.
- `workflow_dispatch` always runs the complete CI floor. Do not use GitHub's native `[skip ci]`
  phrases because they can prevent required checks from registering at all.
- Releases are automatic and happen only from `master` pushes. `tools/release-plan.mjs` looks at
  everything since the last `v*` tag: documentation, CI, tests and test tooling (including
  `crates/nvstraps-s3-probe`) release nothing; a change to `crates/nvstraps-uefi` or
  `crates/nvstraps-core` is a minor release because users must re-flash; any other program change
  is a patch; a commit subject prefixed `feat:`/`minor:` raises to minor and `major:`/`breaking:`/
  `feat!:` or a `BREAKING CHANGE:` footer raises to major. Before the first tag the manifests'
  version is published as is, and a manual bump past the last tag is published as written.
- The Windows job runs after the frontend job, writes the planned version into every manifest
  with `tools/apply-version.mjs` before building, and `tools/publish-release.mjs` then waits for
  the Rust UEFI validation and Miri runs of the same commit, commits the bump as
  `github-actions[bot]`, pushes it to `master`, and creates the Latest release with the build
  attached. Release files never go through the Actions artifact store (its quota is tight); the
  only uploads left are small diagnostics with a seven-day retention. A push made with the
  workflow token starts no workflow run, so the bump commit does not release itself. There are no
  per-commit pre-releases any more.

Use the smallest relevant subset while iterating, then the full applicable floor before handoff:

```powershell
npm run check
npm run test:e2e
npm run check:rust
npm run check:miri
npm run check:firmware
npm run tauri:ci
```

`npm run check:miri` requires nightly Rust with the `miri` component. It interprets the shared
host contracts and the real volatile BAR1 MMIO read/write boundary. Target-only UEFI protocol
callbacks and Windows system FFI remain covered by compilation, Clippy, native tests, and QEMU;
Miri cannot execute those external firmware or operating-system calls.

`npm run test:qemu` is the isolated Linux/OVMF smoke path when QEMU and OVMF are available: four
boots that prove dispatch, the configured host-bridge hook, S3 Save State protocol access, and a
real ACPI S3 suspend/resume cycle driven by the `nvstraps-s3-probe` UEFI application. QEMU has no
NVIDIA GPU, so none of it proves a BAR change; that proof stays with physical trials. The
ignored Rust smoke tests require real NVIDIA hardware or network access and must remain explicit,
opt-in evidence rather than silently joining ordinary validation. `nvidia_profiles::on_pc` runs the
driver settings handoff against the installed driver; its write tests change real driver profiles,
need administrator rights and `NVSTRAPS_DRIVER_WRITE=1`, and end with the undo.
