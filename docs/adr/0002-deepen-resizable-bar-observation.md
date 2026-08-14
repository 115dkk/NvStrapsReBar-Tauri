# ADR 0002: Deepen Resizable BAR observation

- Status: Accepted
- Date: 2026-08-14

## Context

The original `nvidia_smi.rs` owned serialized contracts, two Tauri commands, Deployment Plan
orchestration, external-process hardening, XML decoding, PCI reconciliation, per-GPU aperture
classification, aggregation, and tests. This low Locality allowed current observation and
deployment proof vocabulary to leak into each other.

The aggregate also collapsed a machine with expanded and 256 MiB target GPUs into
`legacy256MiB`. The renderer then hid the expanded rows. A legacy observation combined with an
indeterminate observation similarly hid uncertainty.

## Decision

Adopt one deep `Resizable BAR observation` Module:

- `resizable_bar/mod.rs` owns the small typed Interface and wire facts.
- `resizable_bar/assessment.rs` is the private Implementation for reconciliation,
  classification, aggregation, patch-configuration eligibility, and exact-profile proof.
- `resizable_bar/nvidia_smi.rs` is the private External Adapter for installed executable
  discovery, bounded process capture, provenance, and XML decoding.
- `resizable_bar_commands.rs` is a thin Tauri Adapter. Only the plan-bound command coordinates
  exact-deployment loading and durable workflow transition.

The Interface exposes a plan-free current-aperture observation and a plan-bound exact-profile
evidence operation. It does not expose process execution, XML, Tauri state, or Deployment Plan
revision mechanics.

Aggregate current aperture state follows these ordered rules:

1. An empty target set is `indeterminate`.
2. Any `indeterminate` member makes the aggregate `indeterminate`.
3. All expanded members make the aggregate `expanded`.
4. All 256 MiB members make the aggregate `legacy256MiB`.
5. Expanded and 256 MiB members together, with no indeterminate member, make the aggregate
   `mixed`.

Every target GPU remains present in the Interface. Per-GPU patch information means only that this
application can construct a configuration using its canonical registry and BAR0 validation. It
does not claim firmware compatibility or successful application. Actual success requires a later
expanded-aperture observation after reboot.

Do not introduce a process-runner trait Seam while there is only one production External Adapter.
Fixture tests are not a second runtime Adapter. Keep Hardware support determination separate: it
owns capability; this Module owns current activation and deployment proof.

## Consequences

- Current observation and exact-profile proof reuse one classification Implementation.
- Mixed machines identify every expanded, 256 MiB, and indeterminate GPU without hiding rows.
- Uncertainty cannot be weakened by adding a known legacy GPU.
- Tauri command names, plan persistence, and evidence provenance remain compatible.
- A new runtime telemetry source can be added later only if it justifies a real Adapter Seam.
- Patch configuration availability is useful preflight information, but remains deliberately
  weaker than a claim of patch success.
