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
- Keep vendor flash, firmware settings, physical recovery, hardware changes, and NVIDIA
  per-application policy as visible manual gates. Automate only evidence the owning system can
  actually prove.
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
  BAR1 observation, and NVIDIA policy review.
- Preserve camel-case wire compatibility across Rust serde types, `src/types.ts`, `src/bridge.ts`,
  preview fixtures, and Playwright journeys. A bridge mock may simulate a capability, but must
  preserve ordering, stale-reply rejection, failure truth, and revision semantics.

## Frontend ownership

- Any change to a rendered screen, interaction, user-facing state/copy, layout, styling, or its
  bridge-driven journey must be delegated to a GPT-5.6 Sol sub-agent. Do not use another model to
  make frontend design judgments.
- Explicitly activate and follow `superloopy:superloopy-frontend` for that delegated work. The main
  agent reads the skill, constrains the Rust contract, reviews the result, runs final gates, and
  owns commits; the Sol agent does not commit.
- Use a fresh `.superloopy/evidence/frontend/<run-id>/` for each logical frontend run. Visible or
  spatial changes require proportional `UX_CONTRACT.md`, `VISUAL_QA.md`, rendered Chromium
  captures, and helper verification. Record native and physical limitations explicitly.
- Preserve the established React/CSS design system, keyboard behavior, visible focus, modal focus
  containment and restoration, stale-response guards, duplicate-submit guards, and the supported
  minimum 900 px window. Exercise the affected journey at 1180x760 and the 900 px minimum.

## Commits and recovery

- Preserve unrelated user changes. Stage explicit paths only.
- Make small, logical, reversible commits: one domain behavior, adapter, frontend journey,
  architecture refactor, documentation update, or CI change per commit. Do not hide unrelated work
  in a catch-all commit.
- Run the narrow relevant tests before each commit and report the evidence. Run broader gates after
  the sequence. Do not amend, squash, reset, or rewrite history unless the user asks.
- If an external side effect succeeds but plan persistence fails, keep retries idempotent and never
  claim the plan advanced. Add fault-injection coverage for such boundaries.

## Validation gates

Use the smallest relevant subset while iterating, then the full applicable floor before handoff:

```powershell
npm run check
npm run test:e2e
npm run check:rust
npm run check:firmware
npm run tauri:ci
```

`npm run test:qemu` is the isolated Linux/OVMF smoke path when QEMU and OVMF are available. The two
ignored Rust smoke tests require real NVIDIA hardware or network access and must remain explicit,
opt-in evidence rather than silently joining ordinary validation.
