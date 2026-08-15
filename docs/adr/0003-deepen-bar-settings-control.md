# ADR 0003: Deepen BAR settings control

- Status: Accepted
- Date: 2026-08-16

## Context

The application exposes three related but different facts:

- the volatile status written when the NvStrapsReBar DXE driver executes during the current boot;
- the non-volatile configuration read by that driver on a later boot; and
- the current BAR aperture observed from Windows and NVIDIA telemetry.

A saved configuration does not prove that the DXE driver executed during the current boot.
Likewise, a missing volatile status cannot prove that the driver is absent from the firmware
image. For a canonical Turing GPU, however, a Windows aperture larger than the legacy 256 MiB
window is direct evidence that the NvStraps technique is active: this GPU family has no native
path to that state. Settings writes also need to reject a renderer draft after either the GPU
topology or saved firmware configuration changes.

## Decision

Use a deep Rust `BAR settings control` Module.

Its typed Interface reports:

- current-boot DXE state as `observedThisBoot`, `notObservedThisBoot`, or `indeterminate`;
- control evidence as `currentBootDxe`, `expandedTuringAperture`, `notObserved`, or
  `indeterminate`;
- saved configuration state as `enabled`, `disabled`, `invalid`, or `unreadable`;
- whether Settings is available; and
- canonical topology and configuration tokens.

Settings is available when either a recognized volatile status proves current-boot DXE execution
or the Windows inventory reports an expanded canonical Turing aperture. Recognized error statuses
still prove execution and permit repair. Without either fact, missing status is `notObserved` and
malformed, unreadable, sentinel, or unknown status is `indeterminate`. Firmware-variable access
and the configuration token govern whether the current process may edit and save; they do not
reclassify an active Turing system as uninstalled.

A Settings save re-reads the volatile status, enumerates the current GPU/bridge/BAR0 topology,
requires current-boot DXE or an expanded Turing aperture, reads the current configuration,
compares both caller tokens, validates and rebuilds the wire configuration, writes it, and
verifies exact readback. Deployment and Settings reuse the same private write/readback
transaction.

The existing `ConfigDraft` remains the settings model. Upstream's E/D action changes only the
global automatic-GPU policy; it is not a universal ReBAR switch. A default draft removes the
saved operational configuration and therefore is an explicit consequence action, not a boolean
alias.

Initial renderer routing is derived from independent facts: Settings must be available and the
current aperture aggregate must be exactly `expanded`. Mixed, legacy, indeterminate, loading, and
error observations keep Configure as the initial workspace. An expanded Turing aperture may
unlock Settings even when the status variable is unavailable. Renderer routing never unlocks
Settings from saved configuration alone and never overrides a user's later workspace choice.

## Consequences

- Volatile execution, persistent configuration, and current activation stay separately named.
- Older upstream installations without a readable status variable remain controllable when their
  expanded Turing aperture is observed.
- A machine with a current DXE error can open Settings and repair its configuration.
- A stale renderer cannot overwrite a newer topology or configuration through the Settings path.
- The Resizable BAR observation Module remains independent, preserving ADR 0002.
- Preview fixtures must model DXE observation and aperture state independently.
- The application cannot claim permanent firmware installation from a volatile status alone.
