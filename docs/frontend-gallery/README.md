# Frontend gallery

This is a visual tour of the current NvStrapsReBar Tauri frontend, from guarded
configuration to the recoverable deployment workflow.

> [!IMPORTANT]
> These captures come from the production Chromium build running the
> repository's browser-preview fixtures. They demonstrate the embedded client
> layout and mocked journey only. They do **not** prove native WebView2
> behavior, native dialogs, firmware reads or writes, flashing, reboot, or
> NVIDIA hardware results.

The 900 px captures show the app's supported minimum **desktop** window. The
gallery uses one image per section so it remains comfortable to browse on a
phone; it does not imply a mobile app or a 390 px application viewport.

## 1. Configure at a glance

Detected hardware, the global policy, target BAR size, and explicit GPU rules
stay visible in one desktop workspace.

[Open full-size image](01-configure-overview-1180x760.png)

![Configuration overview at 1180 by 760 pixels](01-configure-overview-1180x760.png)

## 2. Review a consequential write

Changing policy creates an unsaved draft. The final dialog names the UEFI
write, restart consequence, topology check, and read-back verification before
continuing.

[Open full-size image](02-save-confirmation-900x760.png)

![Consequential UEFI write confirmation at the supported 900 px minimum width](02-save-confirmation-900x760.png)

## 3. Pin the exact machine and recovery route

Deployment begins with one inspected vendor image, immutable machine identity,
documented install route, and physical recovery plan. The preview banner and
**NO AUTO-FLASH** boundary remain visible.

[Open full-size image](03-machine-profile-1180x760.png)

![Exact-machine deployment profile at 1180 by 760 pixels](03-machine-profile-1180x760.png)

## 4. Stop at the vendor-owned flash gate

After the repository verifies a derived artifact, the plan advances to a
manual vendor handoff. Preparation is kept distinct from flashing, and the
active step is still explicit at the 900 px desktop minimum.

[Open full-size image](04-manual-flash-gate-900x760.png)

![Manual vendor flash gate at the supported 900 px minimum width](04-manual-flash-gate-900x760.png)

## 5. Bind legacy risk to one firmware fingerprint

Read-only legacy analysis separates a recommended rule, a blocked rule, and a
risky DSDT modification. Selecting the risky rule requires a note and
confirmation tied to the exact analyzed image.

[Open full-size image](05-legacy-risk-acknowledgement-900x760.png)

![Fingerprint-specific legacy risk acknowledgement at the supported 900 px minimum width](05-legacy-risk-acknowledgement-900x760.png)

## 6. Review the backend-owned recommendation

After current-boot and Rust DXE verification, the active plan step shows the
exact registry and fallback recommendation. The guarded write stays disabled
until the selected profile's recommendation is reviewed.

[Open full-size image](06-backend-recommendation-1180x760.png)

![Backend-recommended deployment configuration at 1180 by 760 pixels](06-backend-recommendation-1180x760.png)

---

Captured on Windows with Chromium 151.0.7922.34, `en-US`, 1x device scale, and
reduced motion. Source build: repository `master` at `7794b6d`.
