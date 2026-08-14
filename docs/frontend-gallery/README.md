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

## 7. 한국어로 구성 확인

언어를 바꾸면 페이지를 새로 불러오지 않아도 구성 화면, 접근성 이름,
상태 문구가 바로 한국어로 바뀝니다. 편집 중인 초안과 선택값은 그대로
유지됩니다.

[원본 크기로 보기](07-korean-configure-1180x760.png)

![1180×760 한국어 펌웨어 구성 화면](07-korean-configure-1180x760.png)

## 8. 한국어로 배포 권장 구성 검토

최소 지원 폭 900 px에서도 현재 단계, 백엔드 권장 구성, 검토 확인란이
한 화면에 들어옵니다. 해시, 장치 이름, 선택자 값 같은 기술 정보는
번역하지 않습니다.

[원본 크기로 보기](08-korean-recommendation-900x760.png)

![900×760 한국어 백엔드 권장 배포 구성 화면](08-korean-recommendation-900x760.png)

---

Captured on Windows with Chromium 151.0.7922.34, `en-US`, 1x device scale, and
reduced motion. Original English capture source: `7794b6d`. Korean capture
source: `e53b28b`.
