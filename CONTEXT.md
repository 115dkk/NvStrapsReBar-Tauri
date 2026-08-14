# NvStrapsReBar domain context

## Purpose

NvStrapsReBar prepares and verifies a recoverable, exact-machine firmware deployment for NVIDIA
Turing Resizable BAR. It does not own vendor flashing, motherboard firmware settings, physical
recovery, the NVIDIA driver, or per-application NVIDIA policy.

## Domain language

### Machine Profile

An immutable record of one exact initial board, BIOS, GPU/bridge/BAR0 topology, source-firmware
fingerprint, recovery route, firmware-install route, and optional legacy patch bundle. A changed
identity or source image outside the plan's controlled boot handoffs is a different Machine
Profile, not an update to the old one.

### Exact-machine preflight

A fresh comparison of the current board, BIOS, PCI topology, BAR0 ranges, and preserved source
image with the latest pinned identity. Every consequential deployment action requires an exact
match except for a narrowly typed boot handoff: the first post-flash boot may change only BIOS
version/release date and BAR0, while the later configuration reboot may change only BAR0.

### Boot Observation

Canonical evidence containing the complete current identity and observation time after a proven
boot. The first valid volatile DXE status re-pins the post-flash BIOS revision and BAR0. The later
Windows boot-time proof re-pins configuration-time BAR0. All following actions compare exactly to
the newest observation.

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

### Legacy catalog authority

The Rust Module that owns the trusted UEFIPatch commit and sources, catalog digests, rule risks,
profile validation, analysis, application order, and receipt validation. FFS parsing is its
low-level Implementation; Tauri only adapts its typed results to commands and durable storage.

### Firmware device transaction

The bounded UEFI operation that remaps one bridge and GPU BAR0, programs BAR1 straps, then offers
both mappings their reverse-order restore. One execution Module owns that ordering; the production
UEFI adapter and host simulation adapter only perform its individual operations.

### Deployment Workspace Session

The deep TypeScript Module that owns one Machine Profile and its latest Deployment Plan's
non-authoritative client projection. Its small view/dispatch/subscribe/dispose Interface hides
single-flight execution, stale-response rejection, receipt validation, confirmation binding, and
active-step presentation. The Tauri and browser-preview adapters implement its deployment Seam;
only Rust remains authoritative for durable plan transitions.

### External adapter

A narrowly verified handoff to software the repository does not own. Current external adapters
are the installed `nvidia-smi.exe` and a pinned official NVIDIA Profile Inspector release.

### Hardware support determination

The repository-owned Rust Module that classifies motherboard native Resizable BAR support and
target GPU-family support from the current Machine Identity. Its versioned compiled catalog and
canonical GPU predicates are Implementation details behind one typed Interface. A stable catalog
ID lets adapters select board-specific defaults without repeating identity rules. A missing board
catalog entry means unknown, not unsupported. Support determination is independent from observing
the current BAR aperture.

### Resizable BAR observation

The deep Rust Module that owns installed NVIDIA telemetry capture, reconciliation with the Windows
PCI inventory, per-GPU aperture classification, mixed-state aggregation, application-owned patch
configuration eligibility, and exact-profile expanded-aperture proof. Its small typed Interface
separates plan-free current observation from plan-bound deployment evidence. Hardware capability
remains the independent responsibility of Hardware support determination.

## Load-bearing invariants

- Repository-owned runtime and build code is Rust or TypeScript; the RIIR gate rejects C/C++ and
  the removed EDK2 build path.
- Hardware support knowledge is compiled into the Rust release; it does not depend on an external
  database or service. Known capability and current activation are reported as separate facts.
- A mixed aperture observation preserves every target GPU row. Indeterminate evidence dominates
  aggregate state, and a patch configuration fact never claims that firmware application will
  succeed; success is established only by a later current-aperture observation.
- Source firmware is never overwritten, flashed, or treated as interchangeable by file name.
- A Machine Profile and Deployment Plan are bound to the same profile ID, source SHA-256, and
  recovery route.
- Controlled boot identity transitions never permit a different board, BIOS vendor, GPU identity,
  subsystem, PCI location, or bridge. The resulting complete identity is immediately re-pinned.
- Deployment Plan order, evidence kind, evidence value rules, and revision transitions have one
  canonical Rust owner.
- A Firmware device transaction always attempts device restore before bridge restore, and a failed
  operation cannot bypass restoration of an earlier successful remap.
- Legacy catalog pins, risks, analysis, patch application, and receipts must all pass through the
  same Legacy catalog authority.
- The Deployment Workspace Session may validate and project Rust receipts but never invent a
  production plan transition. Preview persistence selects immutable fixture snapshots and cannot
  stand in for durable or hardware evidence.
- Every persisted artifact is read back and content-addressed; an existing different artifact is
  an immutable conflict.
- Vendor flash, UEFI settings, NVIDIA application policy, hardware work, and physical recovery
  remain truthful manual gates. Reboot completion requires evidence from the rebooted system and
  is never inferred from accepting a restart request.
- Preview-mode browser fixtures prove only the embedded client journey. They never prove native
  dialogs, EFI writes, firmware parsing on a real image, flashing, reboot, or hardware recovery.
