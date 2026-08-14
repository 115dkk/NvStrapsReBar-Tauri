# ADR 0001: Compile hardware support knowledge into Rust

- Status: Accepted
- Date: 2026-08-14

## Context

The application can read the current motherboard identity and GPU inventory. It needs to report
known native Resizable BAR support without confusing a missing catalog entry with unsupported
hardware, and without confusing hardware capability with the currently observed BAR aperture.

This knowledge changes with application releases. It is not user-authored, transactional, or a
shared operational record.

## Decision

Use a repository-owned Rust `Hardware support determination` Module. Its compiled board catalog
and canonical GPU-family predicates remain private Implementation details behind a typed
Interface projected into `SystemSnapshot`.

The Interface reports motherboard support with a stable catalog ID, each target GPU's family
support, and an aggregate state. Renderer adapters use that ID for board-specific defaults instead
of repeating manufacturer, product, and version matching. Catalog absence is `unknown`;
`unsupported` requires an explicit negative rule. Current Resizable BAR activation remains a
separate read-only observation.

Do not use MySQL or another runtime database for hardware support knowledge.

## Consequences

- The application works offline and cannot drift from the catalog version shipped with it.
- Catalog and rule changes are reviewed, tested, versioned, and released with the code.
- The renderer consumes facts and stable reason codes instead of owning board detection rules.
- Adding support knowledge requires a code change and release. That is intentional for this
  release-owned data.
- A future generated catalog may replace hand-written constants while preserving the same Module
  Interface and invariants.
