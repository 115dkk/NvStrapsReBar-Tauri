import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "en" | "ko";
export const LANGUAGE_STORAGE_KEY = "nvstraps-rebar.ui.language";

declare global {
        interface Window { __NVSTRAPS_I18N_MISSING__?: string[] }
}

const ko: Record<string, string> = {
        Language: "언어", "Reading system state": "시스템 상태를 읽는 중",
        Licenses: "라이선스", "THIRD-PARTY SOFTWARE": "서드파티 소프트웨어", "Open-source licenses": "오픈 소스 라이선스", Close: "닫기",
        "Pretendard v1.3.9 is bundled with this application under the SIL Open Font License 1.1.": "Pretendard v1.3.9는 이 앱에 포함되어 있으며 SIL 오픈 폰트 라이선스 1.1에 따라 배포됩니다.",
        "Full license text": "라이선스 전문", "Loading the bundled license text…": "내장된 라이선스 전문을 불러오는 중…", "The bundled license text could not be loaded.": "내장된 라이선스 전문을 불러오지 못했습니다.",
        "Inspecting UEFI access and NVIDIA adapters…": "UEFI 접근 권한과 NVIDIA 어댑터를 확인하고 있습니다…",
        "System state unavailable": "시스템 상태를 확인할 수 없음", "The native bridge did not return a snapshot.": "네이티브 브리지에서 시스템 정보를 받지 못했습니다.",
        "Try again": "다시 시도", "PREVIEW DATA · Browser fixture": "미리보기 데이터 · 브라우저 테스트 전용",
        "Firmware configuration": "펌웨어 구성", "Deployment workspace": "배포 작업 공간", "Application workspace": "작업 공간", Configure: "구성", Deploy: "배포",
        "UNSAVED EDITS": "저장하지 않은 변경 사항", "IN SYNC": "동기화됨", "Refresh system": "시스템 새로 고침", "System status": "시스템 상태", "System gate": "시스템 점검",
        Windows: "Windows", "UEFI boot": "UEFI 부팅", Administrator: "관리자 권한", "Firmware access": "펌웨어 접근", "Driver state": "드라이버 상태", Unavailable: "사용할 수 없음",
        "Saved variable": "저장된 변수", Unknown: "알 수 없음", Present: "있음", "Not present": "없음", Configured: "구성됨", Architecture: "아키텍처", "Restart as administrator": "관리자 권한으로 다시 시작",
        "Hardware changes": "하드웨어 변경", "After changing a GPU or PCI topology, refresh the system and review the saved selectors.": "GPU나 PCI 구성을 바꾼 뒤에는 시스템을 새로 고치고 저장된 선택값을 확인하세요.",
        "ACTIVE SYSTEM / EDITABLE DRAFT": "현재 시스템 / 편집 중인 초안", "Configure what firmware applies at next boot": "다음 부팅 때 적용할 펌웨어 설정",
        "Changes are written to a UEFI variable and take effect after Windows restarts.": "변경 사항은 UEFI 변수에 기록되며 Windows를 다시 시작하면 적용됩니다.",
        "Operation failed": "작업 실패", "Dismiss error": "오류 닫기", "Automatic policy": "자동 정책", "Choose the default behavior before adding device-specific exceptions.": "장치별 예외를 추가하기 전에 기본 동작을 선택하세요.",
        "Automatic GPU policy": "GPU 자동 정책", Off: "끄기", "Only explicit GPU rules are used.": "직접 추가한 GPU 규칙만 사용합니다.", "Registry only": "레지스트리만 사용",
        "Use sizes from the upstream Turing registry.": "업스트림 Turing 레지스트리에 지정된 크기를 사용합니다.", "Registry + fallback": "레지스트리 + 대체값",
        "Use the registry, or 2 GiB for otherwise unlisted Turing GPUs.": "레지스트리에 없는 Turing GPU에는 2 GiB를 적용합니다.", "Target PCI BAR size": "대상 PCI BAR 크기",
        "System default": "시스템 기본값", "Any supported size": "지원되는 모든 크기", "Selected GPUs only": "선택한 GPU만", "GPU straps only": "GPU 스트랩만",
        "Special modes 64 and 65 limit PCI-side changes. Review validation errors before saving.": "특수 모드 64와 65는 PCI 측 변경을 제한합니다. 저장하기 전에 검증 오류를 확인하세요.",
        "Detected GPUs & rules": "감지된 GPU와 규칙", "Match rules by PCI location. Maximum eight.": "규칙은 PCI 위치로 연결합니다. 최대 8개까지 만들 수 있습니다.",
        "No NVIDIA display adapters detected": "NVIDIA 디스플레이 어댑터가 감지되지 않음", "Refresh after verifying the device is present in Windows Device Manager.": "Windows 장치 관리자에 장치가 표시되는지 확인한 뒤 새로 고침하세요.",
        Family: "제품군", Other: "기타", Effective: "적용값", None: "없음", "Add explicit rule": "명시적 규칙 추가", "Match scope": "일치 범위", "Device ID": "장치 ID", Subsystem: "서브시스템", "PCI location": "PCI 위치",
        "Action / size": "동작 / 크기", "No explicit size": "크기를 지정하지 않음", "Exclude GPU": "GPU 제외", "Size-mask override": "크기 마스크 재정의", "Inherit global": "전역 설정 따름",
        "Force enabled": "항상 켜기", "Force disabled": "항상 끄기", Remove: "제거", "All configured rules": "구성된 모든 규칙",
        "Every saved scope remains directly editable, including overlapping priority rules.": "저장된 모든 범위를 직접 편집할 수 있습니다. 우선순위가 겹치는 규칙도 포함됩니다.",
        "Firmware behavior": "펌웨어 동작", "Choose change detection, BAR mask, and resume behavior.": "변경 감지, BAR 마스크, 절전 복귀 동작을 설정합니다.",
        "Check Setup variable changes": "Setup 변수 변경 확인", "Compare the Setup variable fingerprint before applying configuration.": "구성을 적용하기 전에 Setup 변수 지문을 비교합니다.",
        "Override BAR size mask globally": "BAR 크기 마스크 전역 재정의", "Advertise the configured size when capability masks differ.": "기능 마스크가 다를 때 구성한 크기를 알립니다.",
        "Skip S3 resume reconfiguration": "S3 절전 복귀 시 재구성 건너뛰기", "Test S3 resume on this computer after enabling this option.": "이 옵션을 켠 뒤 이 컴퓨터에서 S3 절전 복귀를 테스트하세요.",
        VALIDATION: "검증", "No pending changes": "대기 중인 변경 사항 없음", "Checking draft…": "초안을 확인하는 중…", "Draft is ready for review": "초안을 검토할 수 있음", "Draft needs correction": "초안을 수정해야 함",
        "Discard edits": "변경 사항 버리기", "Review & save": "검토 후 저장", "Configuration written and read back": "구성 기록 및 다시 읽기 완료",
        "Restart Windows when ready. The firmware driver cannot apply this configuration until the next boot.": "준비가 끝나면 Windows를 다시 시작하세요. 다음 부팅 전까지는 펌웨어 드라이버가 이 구성을 적용할 수 없습니다.",
        "CONSEQUENTIAL WRITE": "중요 데이터 쓰기", "Write this draft to UEFI firmware?": "이 초안을 UEFI 펌웨어에 기록할까요?",
        "The application will write and read back the NvStrapsReBar configuration variable. A restart is required before the driver can apply it.": "NvStrapsReBar 구성 변수를 기록한 뒤 다시 읽어 확인합니다. 드라이버가 적용하려면 다시 시작해야 합니다.",
        "Before you continue": "계속하기 전에", "Confirm the detected GPU and PCI topology match this machine. Hardware changes can make saved selectors stale.": "감지된 GPU와 PCI 구성이 이 컴퓨터와 일치하는지 확인하세요. 하드웨어가 바뀌면 저장한 선택값이 맞지 않을 수 있습니다.",
        Cancel: "취소", "Write configuration": "구성 기록", "Deployment status": "배포 상태", "DEPLOYMENT PROFILE": "배포 프로필", "No profile yet": "아직 프로필 없음", "Hardware check": "하드웨어 확인",
        "Artifact prepared": "아티팩트 준비됨", "Package exported": "패키지 내보냄", "BAR1 observed": "BAR1 확인됨", "Active gate": "현재 단계", "No ready step": "진행할 단계 없음",
        "Select a source image and create a profile for this computer first.": "원본 이미지를 선택하고 이 컴퓨터의 프로필을 먼저 만드세요.", "Next step": "다음 단계",
        "CURRENT HARDWARE / PREPARED FILES": "현재 하드웨어 / 준비된 파일", "Firmware preparation and installation": "펌웨어 준비 및 적용",
        "Prepare and inspect firmware files here. Flash the prepared image with the vendor tool, then return to record the result.": "여기에서 펌웨어 파일을 준비하고 검사합니다. 준비된 이미지는 제조사 도구로 플래시한 뒤 돌아와 결과를 기록하세요.",
        "FLASH WITH VENDOR TOOL": "제조사 도구에서 플래시", "Use the prepared image": "준비된 이미지 사용", "Source image and recovery files": "원본 이미지 및 복구 파일",
        "Select the vendor image, inspect its size and SHA-256, and record the installation and recovery instructions.": "제조사 이미지를 선택해 크기와 SHA-256을 확인하고 설치 및 복구 지침을 기록합니다.",
        "board detected": "보드 감지됨", "Native ReBAR, M-FLASH, and Flash BIOS Button defaults are prefilled from the official manual. Confirm them below.": "공식 설명서를 바탕으로 Native ReBAR, M-FLASH, Flash BIOS Button 기본값을 채웠습니다. 아래에서 확인하세요.",
        "Profile name": "프로필 이름", "Selected firmware image": "선택한 펌웨어 이미지", "Choose a vendor BIOS image or enter an absolute path": "제조사 BIOS 이미지를 선택하거나 절대 경로를 입력하세요", "Choose file": "파일 선택", Inspect: "검사",
        "Board path": "보드 경로", "Native Resizable BAR": "네이티브 Resizable BAR", "Legacy Above 4G": "레거시 Above 4G", "Vendor install route": "제조사 설치 경로", "Firmware setup utility": "펌웨어 설정 유틸리티",
        "USB flashback": "USB 플래시백", "Vendor Windows utility": "제조사 Windows 유틸리티", "External SPI programmer": "외부 SPI 프로그래머", "Recovery route": "복구 경로", "Dual BIOS": "듀얼 BIOS", "Vendor recovery": "제조사 복구 기능",
        "None — profile will be refused": "없음 — 프로필을 만들 수 없음", "Official instructions URL": "공식 설명서 URL", "Install handoff note": "설치 인계 메모", "Recovery note": "복구 메모", "READ-ONLY": "읽기 전용",
        "Legacy patch analysis": "레거시 패치 분석", "The Rust analyzer reports match counts for the selected source image.": "Rust 분석기가 선택한 원본 이미지의 일치 개수를 표시합니다.",
        "Analyzing image…": "이미지 분석 중…", "Analyze again": "다시 분석", "Analyze image": "이미지 분석", "Analyzed source": "분석한 원본", "Compatibility rule": "호환성 규칙", RECOMMENDED: "권장",
        "No applicable rules in this catalog.": "이 카탈로그에 적용 가능한 규칙이 없습니다.", "Explicit risk acknowledgements": "위험 항목별 확인", "Include the image-specific consequence.": "이 이미지에 해당하는 결과를 적으세요.",
        "Image-specific acknowledgement note": "이 이미지에 대한 확인 메모", "I reviewed this risk for the analyzed firmware.": "분석한 펌웨어의 해당 위험을 검토했습니다.",
        "I checked the vendor install and recovery instructions for this board.": "이 보드의 제조사 설치 및 복구 지침을 확인했습니다.", "This records the selected installation and recovery instructions.": "선택한 설치 및 복구 지침을 기록합니다.",
        "Create profile for this computer": "이 컴퓨터의 프로필 만들기", "Machine profile": "컴퓨터 프로필", "No stored profiles": "저장된 프로필 없음", "Deployment plan complete": "배포 계획 완료",
        "No remaining steps.": "남은 단계가 없습니다.", "Prepare and inspect firmware artifact": "펌웨어 아티팩트 준비 및 검사", "Review restart to firmware UI": "펌웨어 UI 재시작 검토",
        "Review & confirm completed step": "완료한 단계 검토 및 확인", "Check current boot + Rust DXE status": "현재 부팅 및 Rust DXE 상태 확인", "Loading recommended configuration…": "권장 구성을 불러오는 중…",
        "Recommended deployment configuration": "권장 배포 구성", "Turing GPUs": "Turing GPU", "Registry managed": "레지스트리 관리", "Location-specific fallback rules": "PCI 위치별 대체 규칙",
        "Every detected Turing GPU is covered by the built-in registry; no fallback rule is added.": "감지된 모든 Turing GPU가 내장 레지스트리에 있으므로 대체 규칙을 추가하지 않았습니다.",
        "This draft uses the current GPU and PCI topology. Switch to Configure to choose another policy or size.": "이 초안은 현재 GPU와 PCI 구성을 사용합니다. 다른 정책이나 크기를 고르려면 구성 화면으로 이동하세요.",
        "I reviewed this configuration for the selected profile.": "선택한 프로필의 구성을 검토했습니다.", "Write configuration and read it back": "구성 기록 및 다시 읽기", "Review restart after configuration": "구성 후 재시작 검토",
        "Check Windows boot time": "Windows 부팅 시각 확인", "Collect BAR1 data": "BAR1 데이터 수집", "Install Profile Inspector": "Profile Inspector 설치", "Back up profiles": "프로필 백업", "Back up & launch editor": "백업 후 편집기 실행",
        "After editing the NVIDIA policy, return here and record the result.": "NVIDIA 정책을 편집한 뒤 이 화면으로 돌아와 결과를 기록하세요.", "Review & confirm applied NVIDIA policy": "적용한 NVIDIA 정책 검토 및 확인",
        "Complete this step in its owning tool, then reload the plan. Use Configure for configuration changes.": "해당 도구에서 이 단계를 마친 뒤 계획을 다시 불러오세요. 구성 변경은 구성 화면에서 진행합니다.", "Next: apply the NVIDIA policy, then record the result.": "다음 단계: NVIDIA 정책을 적용하고 결과를 기록하세요.",
        "Profile backup": "프로필 백업",
        "Check current hardware and source image": "현재 하드웨어 및 원본 이미지 확인", "Prepared firmware artifact": "준비된 펌웨어 아티팩트", "Next: export this artifact for the vendor tool.": "다음 단계: 제조사 도구에서 쓸 아티팩트를 내보내세요.", "Deployment package destination": "배포 패키지 대상 경로",
        "Choose an empty destination folder": "빈 대상 폴더를 선택하세요", "Choose folder": "폴더 선택", "Export package": "패키지 내보내기", "Package exported — manual handoff next": "패키지 내보냄 — 다음은 수동 인계",
        "Steps completed outside this app": "앱 밖에서 진행하는 단계", "Use the vendor tool for flashing, set firmware values in the firmware screen, then return to continue the plan.": "제조사 도구로 플래시하고 펌웨어 화면에서 설정값을 바꾼 뒤 돌아와 계획을 계속 진행하세요.",
        MANUAL: "수동", "Vendor flash": "제조사 플래시", "Select the exported artifact in the documented vendor utility. Keep power stable.": "문서에 지정된 제조사 유틸리티에서 내보낸 아티팩트를 선택하세요. 전원이 끊기지 않도록 주의해야 합니다.",
        PHYSICAL: "물리 작업", "Recovery files": "복구 파일", "Keep the selected recovery route and original image available before flashing.": "플래시하기 전에 선택한 복구 경로와 원본 이미지를 바로 쓸 수 있게 준비하세요.",
        "UEFI values": "UEFI 설정값", "Set Above 4G Decoding and Resizable BAR in the firmware screen.": "펌웨어 화면에서 Above 4G Decoding과 Resizable BAR를 설정하세요.",
        "IMMEDIATE RESTART": "즉시 다시 시작", "Restart Windows into firmware setup?": "Windows를 다시 시작해 펌웨어 설정으로 들어갈까요?", "Windows opens the firmware setup screen; continue there with the vendor instructions.": "Windows가 펌웨어 설정 화면을 엽니다. 제조사 지침에 따라 그 화면에서 계속 진행하세요.",
        "I saved and closed my work.": "작업을 저장하고 열려 있던 프로그램을 닫았습니다.", "Windows restarts immediately. Save and close your work first.": "Windows가 즉시 다시 시작됩니다. 먼저 작업을 저장하고 열려 있는 프로그램을 닫으세요.", "Restart to firmware UI": "펌웨어 UI로 다시 시작",
        "Review the result in the owning tool, then record this step.": "해당 도구에서 결과를 확인한 뒤 이 단계를 기록하세요.", "I completed this step and reviewed the result.": "이 단계를 완료하고 결과를 검토했습니다.",
        "Record completed step": "완료한 단계 기록", "RESTART REQUEST": "재시작 요청",
        "Restart Windows after configuration?": "구성을 마친 뒤 Windows를 다시 시작할까요?", "Return after Windows boots so the app can compare the new boot time.": "Windows가 부팅되면 돌아오세요. 앱에서 새 부팅 시각을 비교합니다.",
        "Request restart": "재시작 요청", "Discard unsaved edits and refresh hardware?": "저장하지 않은 변경 사항을 버리고 하드웨어 정보를 새로 고칠까요?", "Windows restarts immediately. Return after Windows boots to continue.": "Windows가 즉시 다시 시작됩니다. 부팅이 끝나면 돌아와 계속 진행하세요.",
        "Use Configure or reload this profile and try again.": "구성 화면을 사용하거나 이 프로필을 다시 불러온 뒤 재시도하세요.", bytes: "바이트", Blocked: "차단됨",
        "The analyzer found no supported match.": "분석기에서 지원되는 일치 항목을 찾지 못했습니다.", "Creating profile…": "프로필 만드는 중…", "Check & export": "확인 및 내보내기",
        "Compare the current hardware and source image, prepare the Rust firmware artifact, and export the package.": "현재 하드웨어와 원본 이미지를 비교하고 Rust 펌웨어 아티팩트를 준비해 패키지로 내보냅니다.",
        "Deployment complete": "배포 완료", "Complete the active step to continue.": "계속하려면 현재 단계를 완료하세요.", "Deployment plan": "배포 계획",
        "Compare current hardware, BIOS, topology, and source image": "현재 하드웨어, BIOS, PCI 구성, 원본 이미지 비교",
        "Record the firmware recovery route": "펌웨어 복구 경로 기록", "Preserve and hash the source firmware image": "원본 펌웨어 이미지 보존 및 해시 기록",
        "Build and inspect the Rust DXE driver": "Rust DXE 드라이버 빌드 및 검사", "Inject the driver and inspect the firmware artifact": "드라이버 삽입 및 펌웨어 아티팩트 검사",
        "Flash with the documented vendor route": "문서에 지정된 제조사 경로로 플래시", "Confirm firmware setup values": "펌웨어 설정값 확인",
        "Boot Windows after the firmware handoff": "펌웨어 인계 후 Windows 부팅", "Read the firmware driver status": "펌웨어 드라이버 상태 읽기",
        "Write and read back the NvStrapsReBar configuration": "NvStrapsReBar 구성 기록 및 다시 읽기", "Restart after configuration": "구성 후 다시 시작",
        "Observe Resizable BAR through NVIDIA telemetry": "NVIDIA 텔레메트리로 Resizable BAR 확인", "Configure NVIDIA application profiles": "NVIDIA 애플리케이션 프로필 구성",
        "Apply the profile's legacy-board patch bundle": "프로필의 레거시 보드 패치 묶음 적용", "Select the exported artifact in the documented vendor tool.": "문서에 지정된 제조사 도구에서 내보낸 아티팩트를 선택하세요.",
        "Record completion after the vendor tool reports success.": "제조사 도구가 성공을 표시하면 완료를 기록하세요.",
        "Keep power connected during flashing and keep the recovery files nearby.": "플래시 중에는 전원을 유지하고 복구 파일을 가까이 두세요.",
        "Enable native ReBAR and Above 4G decoding, and disable CSM.": "네이티브 ReBAR와 Above 4G decoding을 켜고 CSM을 끄세요.", "Save these firmware setup values, then return to record the step.": "펌웨어 설정값을 저장한 뒤 돌아와 이 단계를 기록하세요.",
        "Enable Above 4G decoding and disable CSM. This legacy route uses NvStrapsReBar instead of native motherboard ReBAR.": "Above 4G decoding을 켜고 CSM을 끄세요. 이 레거시 경로는 메인보드 네이티브 ReBAR 대신 NvStrapsReBar를 사용합니다.",
        "Apply and review the intended per-application ReBAR policy.": "원하는 앱별 ReBAR 정책을 적용하고 결과를 확인하세요.",
        "Return after editing the policy and record the result.": "정책을 편집한 뒤 돌아와 결과를 기록하세요.",
        "This sends": "다음 명령을 실행합니다:", "RECORD COMPLETED STEP": "완료 단계 기록",
        "For each selected risk, describe this image and include fingerprint": "선택한 위험 항목마다 이 이미지의 상황을 설명하고 다음 지문을 포함하세요:",
        "Manual step recorded in the deployment plan.": "수동 단계를 배포 계획에 기록했습니다.", "Current boot and Rust DXE status recorded": "현재 부팅 및 Rust DXE 상태 기록",
        "Current Windows boot and Rust DXE status recorded.": "현재 Windows 부팅 및 Rust DXE 상태를 기록했습니다.",
        "Deployment configuration written and read back.": "배포 구성을 기록한 뒤 다시 읽었습니다.", "Configuration restart details loaded for review.": "구성 후 재시작 정보를 불러왔습니다.",
        "Configuration restart request accepted": "구성 후 재시작 요청 수락됨", "Windows accepted the restart request. Return after the next boot.": "Windows가 재시작 요청을 받았습니다. 다음 부팅 뒤 돌아오세요.",
        "Windows boot time recorded": "Windows 부팅 시각 기록", "Windows boot after the configuration read-back recorded.": "구성을 다시 읽은 뒤의 Windows 부팅 시각을 기록했습니다.",
        "Resizable BAR observed": "Resizable BAR 확인", "NVIDIA BAR1 data recorded for this profile.": "이 프로필의 NVIDIA BAR1 데이터를 기록했습니다.",
        "Choose and inspect the firmware image first.": "먼저 펌웨어 이미지를 선택하고 검사하세요.", "Source firmware inspected · size and SHA-256 recorded.": "원본 펌웨어 검사 완료 · 크기와 SHA-256 기록",
        "Analyze this firmware image before selecting legacy rules.": "레거시 규칙을 선택하기 전에 이 펌웨어 이미지를 분석하세요.", "Wait for the image analysis to finish.": "이미지 분석이 끝날 때까지 기다리세요.",
        "Legacy analysis complete · source fingerprint and rule results recorded.": "레거시 분석 완료 · 원본 지문과 규칙 결과 기록",
        "Selected legacy rules are linked to this firmware fingerprint. The profile is ready to create.": "선택한 레거시 규칙을 이 펌웨어 지문에 연결했습니다. 이제 프로필을 만들 수 있습니다.",
        "Above 4G decoding compatibility rule": "Above 4G decoding 호환성 규칙", "DSDT resource-window compatibility patch": "DSDT 리소스 창 호환성 패치",
        "Compressed vendor-specific compatibility patch": "압축된 제조사 전용 호환성 패치", "This build does not support the compressed section.": "이 빌드는 압축 섹션을 지원하지 않습니다.",
        "Use M-FLASH to select the exported vendor-format image.": "M-FLASH에서 내보낸 제조사 형식 이미지를 선택하세요.",
        "MSI Flash BIOS Button recovery: MSI.ROM at USB root, rear Flash BIOS port, physical button.": "MSI Flash BIOS Button 복구: USB 루트의 MSI.ROM, 후면 Flash BIOS 포트, 물리 버튼을 사용합니다.",
        "Machine profile created · source image fingerprint recorded.": "컴퓨터 프로필 생성 · 원본 이미지 지문 기록",
        "Firmware artifact prepared · Rust driver inserted and SHA-256 recorded.": "펌웨어 아티팩트 준비 · Rust 드라이버 삽입 및 SHA-256 기록",
        "Current manual step loaded for review.": "현재 수동 단계를 검토할 수 있도록 불러왔습니다.",
        "Deployment package exported · open it in the vendor tool for flashing.": "배포 패키지를 내보냈습니다. 제조사 도구에서 열어 플래시하세요.",
        "Firmware setup restart details loaded for review.": "펌웨어 설정 재시작 정보를 불러왔습니다.",
        "NVIDIA Profile Inspector installed.": "NVIDIA Profile Inspector를 설치했습니다.",
        "Windows is not running in UEFI mode; firmware variables are unavailable.": "Windows가 UEFI 모드로 실행 중이 아니어서 펌웨어 변수를 사용할 수 없습니다.",
        "Administrator access is required to read or save UEFI settings.": "UEFI 설정을 읽거나 저장하려면 관리자 권한이 필요합니다.",
        "No NVIDIA display adapters were detected.": "NVIDIA 디스플레이 어댑터가 감지되지 않았습니다.",
        "S3 resume reconfiguration is disabled. Test S3 resume on this computer.": "S3 절전 복귀 시 재구성이 꺼져 있습니다. 이 컴퓨터에서 S3 절전 복귀를 테스트하세요.",
        "The current settings do not select any detected NVIDIA GPU.": "현재 설정에서 감지된 NVIDIA GPU가 하나도 선택되지 않았습니다.",
        "ACTIVE STEP": "현재 단계", "global mode": "전역 모드", "target selector": "대상 선택값", "skip S3": "S3 건너뛰기", "mask override": "마스크 재정의", "setup guard": "설정 보호",
        General: "일반", "DSDT modification": "DSDT 수정", "NVRAM whitelist change": "NVRAM 허용 목록 변경", "USB controller blacklist": "USB 컨트롤러 차단 목록", "Experimental X79 patch": "실험적 X79 패치",
        Automated: "자동", "Physical confirmation": "물리 작업 확인", "Manual firmware gate": "수동 펌웨어 단계", "External tool": "외부 도구", "Restart gate": "재시작 단계", completed: "완료", ready: "진행 가능", pending: "대기", applicable: "적용 가능", absent: "없음", blocked: "차단", source: "원본", section: "섹션", Requires: "필요 위험",
};
export const translatedSources = Object.freeze(Object.keys(ko));

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
export function resolveLocale(stored: string | null | undefined, languages: readonly string[]): Locale {
        if (stored === "en" || stored === "ko") return stored;
        return languages[0]?.toLowerCase().startsWith("ko") ? "ko" : "en";
}
export function formatNumber(locale: Locale, value: number): string {
        return new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US").format(value);
}
export function formatExactMatches(locale: Locale, value: number): string {
        const count = formatNumber(locale, value);
        return locale === "ko" ? `${count}개 일치` : `${count} ${value === 1 ? "match" : "matches"}`;
}
export function formatAbsentRules(locale: Locale, value: number): string {
        const count = formatNumber(locale, value);
        return locale === "ko"
                ? `이 이미지에 없는 규칙 ${count}개는 선택할 수 없습니다.`
                : `${count} rule${value === 1 ? " is" : "s are"} absent from this image and cannot be selected.`;
}
export function formatValidationSummary(locale: Locale, gpuCount: number, bytes: number): string {
        if (locale === "ko") return `감지된 GPU ${formatNumber(locale, gpuCount)}개에 영향 · ${formatNumber(locale, bytes)}바이트 인코딩`;
        return `${formatNumber(locale, gpuCount)} detected GPU(s) affected · ${formatNumber(locale, bytes)} bytes encoded`;
}
export function formatGpuCountLabel(locale: Locale, value: number): string {
        if (locale === "ko") return "감지된 NVIDIA GPU";
        return `NVIDIA GPU${value === 1 ? "" : "s"}`;
}
export function translate(locale: Locale, source: string): string {
        if (locale === "en") return source;
        const normalized = collapse(source), direct = ko[normalized];
        if (direct) return direct;
        const rule = normalized.match(/^Rule (\d+) match scope$/); if (rule) return `${rule[1]}번 규칙 일치 범위`;
        const action = normalized.match(/^Rule (\d+) action \/ size$/); if (action) return `${action[1]}번 규칙 동작 / 크기`;
        const remove = normalized.match(/^Remove rule (\d+)$/); if (remove) return `${remove[1]}번 규칙 제거`;
        const recorded = normalized.match(/^(.*) recorded$/); if (recorded) return `${translate(locale, recorded[1])} 기록 완료`;
        const completion = normalized.match(/^Completion recorded at (.+)\.$/); if (completion) return `완료 시각: ${completion[1]}.`;
        const detail = normalized.match(/^(.*) · (.*)\. Boot and driver steps advanced\.$/); if (detail) return `${detail[1]} · ${detail[2]}. 부팅 및 드라이버 단계를 진행했습니다.`;
        const saved = normalized.match(/^(\d+) bytes · saved (.+)\. A Windows restart is still required\.$/); if (saved) return `${saved[1]}바이트 · ${saved[2]}에 저장. Windows를 다시 시작해야 합니다.`;
        const boot = normalized.match(/^Boot (.+) is later than configuration read-back (.+)\.$/); if (boot) return `부팅 시각 ${boot[1]}은 구성 다시 읽기 시각 ${boot[2]}보다 늦습니다.`;
        const bar = normalized.match(/^All profile GPUs observed · XML (.+)\.$/); if (bar) return `프로필의 모든 GPU 확인 · XML ${bar[1]}.`;
        const driverStatus = normalized.match(/^Driver status could not be read: (.+)$/); if (driverStatus) return `드라이버 상태를 읽지 못했습니다: ${driverStatus[1]}`;
        const machineIdentity = normalized.match(/^Machine identity could not be pinned: (.+)$/); if (machineIdentity) return `컴퓨터 식별 정보를 고정하지 못했습니다: ${machineIdentity[1]}`;
        const editorLaunch = normalized.match(/^Editor process (.+) launched · next: edit the policy and record the result\.$/); if (editorLaunch) return `편집기 프로세스 ${editorLaunch[1]} 실행됨 · 다음: 정책을 편집하고 결과를 기록하세요.`;
        const legacyProfile = normalized.match(/^Legacy profile created with (\d+) rules? · source fingerprint recorded\.$/); if (legacyProfile) return `레거시 프로필 생성 · 규칙 ${legacyProfile[1]}개 · 원본 지문 기록`;
        const hardwareDifference = normalized.match(/^Hardware check found (\d+) differences?; deployment remains blocked until the selected profile matches\.$/); if (hardwareDifference) return `하드웨어 확인 결과 ${hardwareDifference[1]}개 항목이 다릅니다. 선택한 프로필과 일치해야 배포를 계속할 수 있습니다.`;
        const firmwareUnavailable = normalized.match(/^(.*): administrator privileges are required$/); if (firmwareUnavailable) return `${firmwareUnavailable[1]}: 관리자 권한이 필요합니다`;
        if (typeof window !== "undefined" && /[A-Za-z]/.test(normalized)) {
                const missing = window.__NVSTRAPS_I18N_MISSING__ ??= [];
                if (!missing.includes(normalized)) missing.push(normalized);
        }
        return source;
}

type I18nValue = { locale: Locale; setLocale(locale: Locale): void; t(source: string): string; n(value: number): string; exactMatches(value: number): string; absentRules(value: number): string; validationSummary(gpuCount: number, bytes: number): string; gpuCountLabel(value: number): string };
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
        const [locale, updateLocale] = useState<Locale>(() => resolveLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY), navigator.languages?.length ? navigator.languages : [navigator.language]));
        const setLocale = useCallback((next: Locale) => { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); updateLocale(next); }, []);
        useEffect(() => {
                document.documentElement.lang = locale;
                document.title = locale === "ko" ? "NvStrapsReBar — 펌웨어 배포" : "NvStrapsReBar";
        }, [locale]);
        const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (source) => translate(locale, source), n: (value) => formatNumber(locale, value), exactMatches: (value) => formatExactMatches(locale, value), absentRules: (value) => formatAbsentRules(locale, value), validationSummary: (gpuCount, bytes) => formatValidationSummary(locale, gpuCount, bytes), gpuCountLabel: (value) => formatGpuCountLabel(locale, value) }), [locale, setLocale]);
        return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n(): I18nValue { const value = useContext(I18nContext); if (!value) throw new Error("useI18n must be used inside I18nProvider"); return value; }
