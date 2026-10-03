# Desktop guided design

The executable design source is `src/guided/guided.css` (guided components, `nv-` classes,
ported from the NvStrapsReBar design system) and `src/styles.css` (fonts, base tokens and the
licenses dialog). This document maps that source, not a second theme implementation. The design system artifact and the reviewed screen
designs live outside the repository; the UX contract and visual QA notes are under
`.superloopy/evidence/frontend/`.

## Purpose and hierarchy

NvStrapsReBar prepares a motherboard BIOS file containing NvStrapsReBar, guides the manual
installation, and manages Resizable BAR settings for NVIDIA Turing GPUs.

Copy tells the user what to do next and what the app just did. It never lists what the app does
not do; a manual step appears as the user's action at the moment it is needed. The app is an
instrument, not a conversation partner: no asking, telling, promising or favours, no "I" in
labels, and choices are instructions with options named as states. Headings say the task;
board, GPU and file names go into the lead or the body, not the heading.

- There is no persistent navigation. The system state picks the first page: an installation in
  progress opens its current step, everything else opens home (`src/guided/routing.ts`).
- Home leads with value (`256 MiB → 8 GiB`), then the user's steps and what is needed. After
  installation, home shows the observed state and list rows: BAR settings, per-game setup,
  settings backup, and what to do when the BIOS or hardware changes. The menu (⋯) holds
  refresh, the installation record, a new preparation, earlier preparations, language and
  licenses.
- Installation is shown as four stages (Prepare, Install, Turn on, Finish) in a passive stage
  tracker beside one task panel. The Rust plan keeps all of its steps and receipts; the screen
  groups them. Each screen has one task, one heading and one primary action at the far right of
  a fixed action bar.
- Read-only checks run on their own when their screen opens (driver status after the BIOS
  restart, boot time after the configuration restart, the NVIDIA-reported BAR size). Decisions
  stay buttons: choosing the file, confirming install and recovery methods, choosing the USB
  drive, restarting, recording what happened in BIOS setup, and saving the settings.
- The NVIDIA per-game step is optional. Installation finishes when the new BAR size is observed;
  per-game setup is offered from the finish screen and from home. It is a switch screen: All games
  (on needs consent), the games changed on this PC, search with a switch per game, and the backup
  from before the first change.
- A restart request is never shown as a finished restart; confirmation dialogs ask the user to
  save their work and their left button is Close.
- BAR settings (`src/guided/bar-settings.tsx`) put one expansion switch first, a size for each
  RTX 20 and GTX 16 GPU second (Automatic with the size it resolves to, a size, or Do not
  expand), then two closed disclosures: advanced firmware options and the settings file. A save
  bar appears only while the draft differs from the saved settings; it names the change, offers
  Revert, and Save opens one confirmation. Removing the saved settings is confirmed as turning
  expansion off. `bar-settings-model.ts` mirrors the nvstraps-core lookup order so the screen
  shows the size each GPU actually gets. Validation and the write stay in Rust.
- Native window chrome stays OS-owned. Desktop minimum width remains 900px.

## Color and depth

Use graphite surfaces with a single blue action accent. No industry-wide hardware color
standard is claimed. Depth comes from three surface steps; the dialog shadow is the only shadow.

| Token | Value | Role |
| --- | --- | --- |
| --bg | #11161d | Application canvas |
| --surface | #181f28 | Task panels, dialogs |
| --surface2 | #202a35 | Quiet buttons, file cards, row highlight |
| --line | #35414f | Separators |
| --control-line | #6a7a8d | Control boundaries (3:1 or more) |
| --muted | #a0adbb | Supporting text |
| --ink | #edf2f7 | Primary text |
| --accent | #8ab9f8 | Primary action, links, keyboard focus, current stage |
| --accent-hover | #acd0ff | Action hover |
| --accent-soft | #22354d | Selected choice card |
| --on-accent | #102136 | Text on accent |
| --ok / --ok-soft | #79c99c / #173126 | Observed success and its result header |
| --warn / --warn-soft | #dfb96e / #2e2617 | Remaining work; the one caution before the BIOS install |
| --bad / --bad-soft | #ee918b / #35201f | An actual failure only |

Status always has a text label; color alone is insufficient. Colored backgrounds are reserved
for the result header, the single caution and failure notices.

## Typography and spacing

Segoe UI Variable for English, bundled Pretendard for Korean, and Jetendard (`--font-technical`,
read by the guided `--font-mono`) for file names, paths and BAR size readouts only. Task heading
28px, section 18px, body 15px, supporting 13px. Korean wraps at word boundaries. Spacing uses a
4px basis; task panels use 32px padding (24px at 1000px and narrower).

## Components and adaptation

Stage tracker 248px (208px at 1000px and narrower), task body at most 600px, home column 720px.
Disclosures use native details/summary semantics. GPU rows preserve every device including
mixed and indeterminate states. Unknown capability is not unsupported. Dialog focus trapping,
Escape, Close and focus return remain mandatory. At narrow widths an action bar with three
buttons moves its hint above the buttons.

## Motion

No entrance choreography. 150ms interruptible color, outline and press transitions; buttons
press to 0.96. The progress spinner stops under reduced motion while its text stays.

## Evidence boundary

Browser preview proves the embedded DOM client only. Native WebView2, pickers, packaging
lifecycle and physical firmware operations require their own evidence. Never run a firmware
write, flash or restart for visual QA.
