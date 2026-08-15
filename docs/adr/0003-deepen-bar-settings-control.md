# ADR 0003: Deepen BAR settings control

- Status: Accepted
- Date: 2026-08-16

## Context

The application exposes three related but different facts:

- the volatile status written when the NvStrapsReBar DXE driver executes during the current boot;
- the non-volatile configuration read by that driver on a later boot; and
- the current BAR aperture observed from Windows and NVIDIA telemetry.

A saved configuration or expanded aperture does not prove that the DXE driver executed during the
current boot. Likewise, a missing volatile status cannot prove that the driver is permanently
absent from the firmware image. Settings writes also need to reject a renderer draft after either
the GPU topology or saved firmware configuration changes.

## Decision

Use a deep Rust `BAR settings control` Module.

Its typed Interface reports:

- current-boot DXE state as `observedThisBoot`, `notObservedThisBoot`, or `indeterminate`;
- saved configuration state as `enabled`, `disabled`, `invalid`, or `unreadable`;
- whether Settings is available; and
- canonical topology and configuration tokens.

Settings is available only when a recognized volatile status proves current-boot DXE execution,
firmware variables are accessible, and the current saved configuration has a token. Recognized
error statuses still prove execution and permit repair. Missing, malformed, unreadable, sentinel,
or unknown status values fail closed.

A Settings save re-reads the volatile status, enumerates the current GPU/bridge/BAR0 topology,
reads the current configuration, compares both caller tokens, validates and rebuilds the wire
configuration, writes it, and verifies exact readback. Deployment and Settings reuse the same
private write/readback transaction.

The existing `ConfigDraft` remains the settings model. Upstream's E/D action changes only the
global automatic-GPU policy; it is not a universal ReBAR switch. A default draft removes the
saved operational configuration and therefore is an explicit consequence action, not a boolean
alias.

Initial renderer routing is derived from independent facts: Settings must be available and the
current aperture aggregate must be exactly `expanded`. Mixed, legacy, indeterminate, loading, and
error observations keep Configure as the initial workspace. Renderer routing never unlocks
Settings from configuration or aperture alone and never overrides a user's later workspace
choice.

## Consequences

- Volatile execution, persistent configuration, and current activation stay separately named.
- A machine with a current DXE error can open Settings and repair its configuration.
- A stale renderer cannot overwrite a newer topology or configuration through the Settings path.
- The Resizable BAR observation Module remains independent, preserving ADR 0002.
- Preview fixtures must model DXE observation and aperture state independently.
- The application cannot claim permanent firmware installation from a volatile status alone.
