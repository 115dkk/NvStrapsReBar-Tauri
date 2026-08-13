# NvStrapsReBar domain context

## Purpose

NvStrapsReBar prepares and verifies a recoverable, exact-machine firmware deployment for NVIDIA
Turing Resizable BAR. It does not own vendor flashing, motherboard firmware settings, physical
recovery, the NVIDIA driver, or per-application NVIDIA policy.

## Domain language

### Machine Profile

An immutable record of one exact board, BIOS, GPU/bridge/BAR0 topology, source-firmware
fingerprint, recovery route, firmware-install route, and optional legacy patch bundle. A changed
identity or source image is a different Machine Profile, not an update to the old one.

### Exact-machine preflight

A fresh comparison of the current board, BIOS, PCI topology, BAR0 ranges, and preserved source
image with a Machine Profile. Every consequential deployment action requires an exact match.

### Deployment Plan

The ordered, resumable workflow belonging to one Machine Profile. Its revisions are append-only.
Exactly one step is ready until the plan is complete; completed steps carry evidence and later
steps remain pending.

### Step evidence

A typed, non-empty fact that completes exactly one Deployment Plan step. Digest evidence is
canonical SHA-256. Evidence from a browser handler, local animation, or neighboring step cannot
stand in for evidence from the step's actual owner.

### Automated step

A step whose result is produced and verified by repository-owned Rust, such as exact preflight,
source preservation, Rust driver preparation, legacy patching, artifact verification,
configuration readback, or evidence parsing.

### Manual gate

A Deployment Plan step owned by a person, vendor firmware UI, external tool, or physical process.
The application may prepare the handoff and record an explicit attestation, but must not infer
completion from opening a UI. A reboot is a system-observed gate instead: requesting it never
completes it, while current-boot DXE status or a later Windows boot time may prove it.

### Firmware artifact

A content-addressed, no-overwrite output derived from the preserved source image. Preparing an
artifact never means that it was flashed.

### Deployment package

An immutable export containing the prepared artifact, preserved recovery image, Machine Profile,
Deployment Plan revision, receipts, checksums, instructions, and still-open manual gates.

### Legacy firmware analysis

A read-only scan of one exact firmware fingerprint against pinned patch catalogs. It reports each
rule as applicable, absent, or blocked. Only analyzer-owned match counts and catalog hashes may
enter a legacy Machine Profile.

### External adapter

A narrowly verified handoff to software the repository does not own. Current external adapters
are the installed `nvidia-smi.exe` and a pinned official NVIDIA Profile Inspector release.

## Load-bearing invariants

- Repository-owned runtime and build code is Rust or TypeScript; the RIIR gate rejects C/C++ and
  the removed EDK2 build path.
- Source firmware is never overwritten, flashed, or treated as interchangeable by file name.
- A Machine Profile and Deployment Plan are bound to the same profile ID, source SHA-256, and
  recovery route.
- Deployment Plan order, evidence kind, evidence value rules, and revision transitions have one
  canonical Rust owner.
- Every persisted artifact is read back and content-addressed; an existing different artifact is
  an immutable conflict.
- Vendor flash, UEFI settings, NVIDIA application policy, hardware work, and physical recovery
  remain truthful manual gates. Reboot completion requires evidence from the rebooted system and
  is never inferred from accepting a restart request.
- Preview-mode browser fixtures prove only the embedded client journey. They never prove native
  dialogs, EFI writes, firmware parsing on a real image, flashing, reboot, or hardware recovery.
