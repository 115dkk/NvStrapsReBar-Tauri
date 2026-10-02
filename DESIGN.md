# Desktop workspace design

The executable design source is `src/styles.css` (shared controls, fonts and tokens) plus
`src/workspace-layout.css` (application composition). This document maps that source, not a
second theme implementation.

## Purpose and hierarchy

NvStrapsReBar prepares a motherboard BIOS image containing the NvStrapsReBar driver, guides
the manual installation, and manages Resizable BAR settings for NVIDIA Turing GPUs.

Copy tells the user what to do next and what the app just did. It never lists what the app does
not do; a manual step appears as the user's action at the moment it is needed.

- Start on Overview: purpose, observed PC state, next action, then the installation outline.
- Keep Overview, Install firmware and BAR Settings in one persistent left navigation.
- Installation prioritizes the current plan action. Original-file setup and complete history
  remain reachable as named disclosures after a profile exists. Manual instructions sit next
  to the action they explain. Never infer that opening another tool completed a step.
- Settings put expansion first, GPU exceptions second, advanced firmware options on demand,
  and saved-file import/export last. Preserve edit/review/save semantics.
- Native window chrome stays OS-owned. Desktop minimum width remains 900px.

## Color and depth

Use graphite surfaces with a single blue action accent. No industry-wide hardware color
standard is claimed. NVIDIA's official App screenshots use charcoal/green; Intel's official
XTU guide describes blue normal and yellow attention states. We borrow restrained neutral
surfaces and distinguish actions from outcomes, not their branding or unsupported controls.

| Token | Value | Role |
| --- | --- | --- |
| --bg | #11161d | Application canvas |
| --surface | #181f28 | Grouped controls |
| --surface2 | #202a35 | Raised controls |
| --line | #35414f | Separators and control boundaries |
| --muted | #a0adbb | Supporting text |
| --ink | #edf2f7 | Primary text |
| --accent | #8ab9f8 | Actions, selection, keyboard focus |
| --accent-hover | #acd0ff | Action hover |
| --accent-soft | #22354d | Selection surface |
| --on-accent | #102136 | Text on accent |
| --ok | #79c99c | Observed active/success |
| --warn | #dfb96e | Missing prerequisite or consequence |
| --bad | #ee918b | Error/destructive action |

Tonal surfaces and fine separators provide grouping. Avoid nested decorative cards, colored
status backgrounds for ordinary metadata, large gradients, and decorative gauges. Status
always has a text label; color alone is insufficient.

## Typography and spacing

Retain Segoe UI for English, bundled Pretendard for Korean, and Jetendard for actual technical
values. Main heading 26px; section heading 18px; body 14px; supporting text 13px; technical
values 11–13px. Use Korean word-boundary wrapping. Retain the existing Korean weight tokens.
Use a 4px spacing basis, 24–32px page padding, 16–24px group padding, 8–12px control gaps.

## Components and adaptation

Navigation labels stay visible at 900px. Each workspace has one main landmark, a heading,
and a clear primary action. The sidebar does not duplicate system-status panels. Overview
holds detailed current hardware; workspaces keep a compact status strip. No fake progress
bar: show observed states and actual plan steps only. GPU rows must preserve every device
including mixed and indeterminate states. Unknown capability is not unsupported.

Disclosures use native details/summary semantics and keep their content mounted. Returning
between pages preserves drafts within the current snapshot. Refresh remains explicit and
retains existing discard confirmation and stale-response handling. Dialog focus trapping,
Escape, cancellation and focus return remain mandatory.

## Motion

No new entrance choreography. Preserve 150ms interruptible color/outline/press transitions
and existing reduced-motion behavior. Actions retain the existing 0.96 press scale.

## Evidence boundary

Browser preview proves the embedded DOM client only. Native WebView2, pickers, packaging
lifecycle and physical firmware operations require their own evidence. Never run a firmware
write, flash or restart for visual QA.
