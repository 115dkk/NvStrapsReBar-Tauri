import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "en" | "ko";
export const LANGUAGE_STORAGE_KEY = "nvstraps-rebar.ui.language";

declare global {
        interface Window { __NVSTRAPS_I18N_MISSING__?: string[] }
}

const ko: Record<string, string> = {
        Language: "언어", "Reading system state": "시스템 상태를 읽는 중",
        "Inspecting UEFI access and NVIDIA adapters…": "UEFI 접근 권한과 NVIDIA 어댑터를 확인하고 있습니다…",
        "System state unavailable": "시스템 상태를 확인할 수 없음", "The native bridge did not return a snapshot.": "네이티브 브리지에서 시스템 정보를 받지 못했습니다.",
        "Try again": "다시 시도", "PREVIEW DATA · Browser fixture only · No firmware is being read or written": "미리보기 데이터 · 브라우저 테스트 전용 · 펌웨어를 읽거나 쓰지 않음",
        "Firmware configuration": "펌웨어 구성", "Deployment workspace": "배포 작업 공간", "Application workspace": "작업 공간", Configure: "구성", Deploy: "배포",
        "UNSAVED EDITS": "저장하지 않은 변경 사항", "IN SYNC": "동기화됨", "Refresh system": "시스템 새로 고침", "System status": "시스템 상태", "System gate": "시스템 점검",
        Windows: "Windows", "UEFI boot": "UEFI 부팅", Administrator: "관리자 권한", "Firmware access": "펌웨어 접근", "Driver state": "드라이버 상태", Unavailable: "사용할 수 없음",
        "Saved variable": "저장된 변수", Unknown: "알 수 없음", Present: "있음", "Not present": "없음", Configured: "구성됨", Architecture: "아키텍처", "Restart as administrator": "관리자 권한으로 다시 시작",
        "Hardware safety": "하드웨어 안전", "GPU or PCI topology changes can invalidate saved selectors. Refresh and validate after any hardware change.": "GPU나 PCI 구성이 바뀌면 저장한 선택값이 더는 맞지 않을 수 있습니다. 하드웨어를 변경한 뒤에는 새로 고침하고 다시 검증하세요.",
        "ACTIVE SYSTEM / EDITABLE DRAFT": "현재 시스템 / 편집 중인 초안", "Configure what firmware applies at next boot": "다음 부팅 때 적용할 펌웨어 설정",
        "Changes are written to a UEFI variable. They do not take effect until Windows is restarted.": "변경 사항은 UEFI 변수에 기록됩니다. Windows를 다시 시작해야 적용됩니다.",
        "Operation failed": "작업 실패", "Dismiss error": "오류 닫기", "Automatic policy": "자동 정책", "Choose the default behavior before adding device-specific exceptions.": "장치별 예외를 추가하기 전에 기본 동작을 선택하세요.",
        "Automatic GPU policy": "GPU 자동 정책", Off: "끄기", "Only explicit GPU rules are used.": "직접 추가한 GPU 규칙만 사용합니다.", "Registry only": "레지스트리만 사용",
        "Use sizes from the upstream Turing registry.": "업스트림 Turing 레지스트리에 지정된 크기를 사용합니다.", "Registry + fallback": "레지스트리 + 대체값",
        "Use the registry, or 2 GiB for otherwise unlisted Turing GPUs.": "레지스트리에 없는 Turing GPU에는 2 GiB를 적용합니다.", "Target PCI BAR size": "대상 PCI BAR 크기",
        "System default": "시스템 기본값", "Any supported size": "지원되는 모든 크기", "Selected GPUs only": "선택한 GPU만", "GPU straps only": "GPU 스트랩만",
        "Special modes 64 and 65 constrain PCI-side changes; validation remains authoritative.": "특수 모드 64와 65는 PCI 측 변경을 제한합니다. 최종 판단은 검증 결과를 따릅니다.",
        "Detected GPUs & rules": "감지된 GPU와 규칙", "Rules are matched most safely by PCI location. Maximum eight.": "PCI 위치로 일치시키는 방식이 가장 안전합니다. 규칙은 최대 8개까지 만들 수 있습니다.",
        "No NVIDIA display adapters detected": "NVIDIA 디스플레이 어댑터가 감지되지 않음", "Refresh after verifying the device is present in Windows Device Manager.": "Windows 장치 관리자에 장치가 표시되는지 확인한 뒤 새로 고침하세요.",
        Family: "제품군", Other: "기타", Effective: "적용값", None: "없음", "Add explicit rule": "명시적 규칙 추가", "Match scope": "일치 범위", "Device ID": "장치 ID", Subsystem: "서브시스템", "PCI location": "PCI 위치",
        "Action / size": "동작 / 크기", "No explicit size": "크기를 지정하지 않음", "Exclude GPU": "GPU 제외", "Size-mask override": "크기 마스크 재정의", "Inherit global": "전역 설정 따름",
        "Force enabled": "항상 켜기", "Force disabled": "항상 끄기", Remove: "제거", "All configured rules": "구성된 모든 규칙",
        "Every saved scope remains directly editable, including overlapping priority rules.": "저장된 모든 범위를 직접 편집할 수 있습니다. 우선순위가 겹치는 규칙도 포함됩니다.",
        "Advanced safety": "고급 안전 설정", "Defaults favor change detection and conservative firmware behavior.": "기본값은 변경 감지와 보수적인 펌웨어 동작을 우선합니다.",
        "Guard against Setup variable changes": "Setup 변수 변경 감지", "Keep the firmware setup fingerprint check enabled.": "펌웨어 설정 지문 검사를 계속 사용합니다.",
        "Override BAR size mask globally": "BAR 크기 마스크 전역 재정의", "Advertise the configured size when capability masks differ.": "기능 마스크가 다를 때 구성한 크기를 알립니다.",
        "Skip S3 resume reconfiguration": "S3 절전 복귀 시 재구성 건너뛰기", "Resume behavior must be verified on this machine.": "이 컴퓨터에서 절전 복귀 동작을 직접 검증해야 합니다.",
        VALIDATION: "검증", "No pending changes": "대기 중인 변경 사항 없음", "Checking draft…": "초안을 확인하는 중…", "Draft is ready for review": "초안을 검토할 수 있음", "Draft needs correction": "초안을 수정해야 함",
        "Discard edits": "변경 사항 버리기", "Review & save": "검토 후 저장", "Save verified by read-back": "다시 읽어 저장 확인 완료",
        "Restart Windows when ready. The firmware driver cannot apply this configuration until the next boot.": "준비가 끝나면 Windows를 다시 시작하세요. 다음 부팅 전까지는 펌웨어 드라이버가 이 구성을 적용할 수 없습니다.",
        "CONSEQUENTIAL WRITE": "중요 데이터 쓰기", "Write this draft to UEFI firmware?": "이 초안을 UEFI 펌웨어에 기록할까요?",
        "The application will write and read back the NvStrapsReBar configuration variable. A restart is required before the driver can apply it.": "NvStrapsReBar 구성 변수를 기록한 뒤 다시 읽어 확인합니다. 드라이버가 적용하려면 다시 시작해야 합니다.",
        "Before you continue": "계속하기 전에", "Confirm the detected GPU and PCI topology match this machine. Hardware changes can make saved selectors stale.": "감지된 GPU와 PCI 구성이 이 컴퓨터와 일치하는지 확인하세요. 하드웨어가 바뀌면 저장한 선택값이 맞지 않을 수 있습니다.",
        Cancel: "취소", "Write configuration": "구성 기록", "Deployment status": "배포 상태", "PINNED DEPLOYMENT": "고정된 배포", "No profile yet": "아직 프로필 없음", "Machine preflight": "컴퓨터 사전 점검",
        "Artifact prepared": "아티팩트 준비됨", "Package exported": "패키지 내보냄", "BAR1 observed": "BAR1 확인됨", "Profile ID": "프로필 ID", "Active gate": "현재 단계", "No ready step": "진행할 단계 없음", "Plan revision": "계획 리비전",
        "Select a source image and pin it to this exact machine first.": "먼저 원본 이미지를 선택해 현재 컴퓨터에 고정하세요.", "Manual boundary": "수동 작업 범위",
        "This app prepares and verifies a package. You perform vendor flashing, setup changes, power cycles, and hardware work.": "앱은 패키지를 준비하고 검증합니다. 제조사 도구로 플래시하기, 설정 변경, 전원 재인가, 하드웨어 작업은 사용자가 직접 해야 합니다.",
        "EXACT MACHINE / RECOVERABLE ARTIFACT": "정확한 컴퓨터 / 복구 가능한 아티팩트", "Prepare, hand off, then verify": "준비하고 넘긴 뒤 검증하기",
        "Automated steps stop at signed evidence. Physical and firmware-screen steps stay visible as gates.": "자동화는 서명된 증거를 남기는 데서 멈춥니다. 물리 작업과 펌웨어 화면 작업은 수동 단계로 계속 표시됩니다.",
        "NO AUTO-FLASH": "자동 플래시 안 함", "Manual vendor handoff": "제조사 도구에 수동 전달", "Dismiss operation status": "작업 상태 닫기", "Pin source & recovery": "원본과 복구 경로 고정",
        "Read and hash the exact vendor image, then document the install and recovery route.": "정확한 제조사 이미지를 읽고 해시한 뒤 설치 및 복구 경로를 기록합니다.",
        "Exact MSI board recognized": "정확한 MSI 보드 확인됨", "Native ReBAR, M-FLASH, and Flash BIOS Button defaults are prefilled from the official manual. Confirm them below.": "공식 설명서를 바탕으로 Native ReBAR, M-FLASH, Flash BIOS Button 기본값을 채웠습니다. 아래에서 확인하세요.",
        "Profile name": "프로필 이름", "Exact firmware image": "정확한 펌웨어 이미지", "Choose a vendor BIOS image or enter an absolute path": "제조사 BIOS 이미지를 선택하거나 절대 경로를 입력하세요", "Choose file": "파일 선택", Inspect: "검사",
        "Board path": "보드 경로", "Native Resizable BAR": "네이티브 Resizable BAR", "Legacy Above 4G": "레거시 Above 4G", "Vendor install route": "제조사 설치 경로", "Firmware setup utility": "펌웨어 설정 유틸리티",
        "USB flashback": "USB 플래시백", "Vendor Windows utility": "제조사 Windows 유틸리티", "External SPI programmer": "외부 SPI 프로그래머", "Recovery route": "복구 경로", "Dual BIOS": "듀얼 BIOS", "Vendor recovery": "제조사 복구 기능",
        "None — profile will be refused": "없음 — 프로필을 만들 수 없음", "Official instructions URL": "공식 설명서 URL", "Install handoff note": "설치 인계 메모", "Recovery note": "복구 메모", "READ-ONLY": "읽기 전용",
        "Exact legacy patch analysis": "정확한 레거시 패치 분석", "Match counts come only from the pinned Rust analyzer. Analysis does not mutate or flash the image.": "일치 개수는 고정된 Rust 분석기에서만 가져옵니다. 분석 중에는 이미지를 수정하거나 플래시하지 않습니다.",
        "Analyzing exact image…": "정확한 이미지를 분석하는 중…", "Analyze again": "다시 분석", "Analyze exact image": "정확한 이미지 분석", "Analyzed source": "분석한 원본", "Pinned compatibility rule": "고정된 호환성 규칙", RECOMMENDED: "권장",
        "No applicable rules in this catalog.": "이 카탈로그에 적용 가능한 규칙이 없습니다.", "Explicit risk acknowledgements": "위험 항목별 확인", "A generic confirmation is refused.": "구체적이지 않은 확인 문구는 허용되지 않습니다.",
        "Image-specific acknowledgement note": "이 이미지에 대한 확인 메모", "I reviewed this risk for the exact analyzed firmware.": "분석한 펌웨어의 해당 위험을 직접 검토했습니다.",
        "I checked the vendor install and recovery instructions for this board.": "이 보드의 제조사 설치 및 복구 지침을 확인했습니다.", "This confirmation records a documented route; it does not prove a recovery attempt.": "이 확인은 문서로 확인한 경로만 기록합니다. 실제 복구를 시도했다는 증거는 아닙니다.",
        "Create machine-bound profile": "이 컴퓨터에 고정된 프로필 만들기", "Machine profile": "컴퓨터 프로필", "No stored profiles": "저장된 프로필 없음", "Deployment plan complete": "배포 계획 완료",
        "Every durable gate has a persisted receipt.": "모든 필수 단계에 영구 영수증이 저장되었습니다.", "Prepare and verify firmware artifact": "펌웨어 아티팩트 준비 및 검증", "Review restart to firmware UI": "펌웨어 UI 재시작 검토",
        "Review & confirm completed step": "완료한 단계 검토 및 확인", "Verify current boot + Rust DXE": "현재 부팅과 Rust DXE 검증", "Loading the backend-owned recommendation for this exact profile…": "이 프로필에 맞는 백엔드 권장 구성을 불러오는 중…",
        "Backend-recommended deployment configuration": "백엔드 권장 배포 구성", "Turing GPUs": "Turing GPU", "Registry managed": "레지스트리 관리", "Exact fallback rules": "정확한 대체 규칙",
        "Every detected Turing GPU is covered by the built-in registry; no fallback rule is added.": "감지된 모든 Turing GPU가 내장 레지스트리에 있으므로 대체 규칙을 추가하지 않았습니다.",
        "This draft was generated and prevalidated by the backend for the current topology. To choose another policy or size, switch to Configure instead of confirming here.": "백엔드가 현재 하드웨어 구성에 맞춰 이 초안을 만들고 미리 검증했습니다. 다른 정책이나 크기를 고르려면 여기서 확인하지 말고 구성 화면으로 이동하세요.",
        "I reviewed this exact backend recommendation for the selected profile.": "선택한 프로필에 맞는 백엔드 권장 구성을 검토했습니다.", "Write and verify guarded configuration": "보호된 구성 기록 및 검증", "Review restart after configuration": "구성 후 재시작 검토",
        "Verify returned Windows boot": "돌아온 Windows 부팅 검증", "Collect and verify BAR1 evidence": "BAR1 증거 수집 및 검증", "Install verified Profile Inspector": "검증된 Profile Inspector 설치", "Back up profiles": "프로필 백업", "Back up & launch editor": "백업 후 편집기 실행",
        "Installing, backing up, or launching the editor does not complete policy application.": "편집기를 설치하거나 실행하고 프로필을 백업해도 정책 적용 단계는 완료되지 않습니다.", "Review & confirm applied NVIDIA policy": "적용한 NVIDIA 정책 검토 및 확인",
        "This durable step has no frontend action. Reload the plan or use Configure for configuration changes.": "이 필수 단계는 프론트엔드에서 진행할 수 없습니다. 계획을 다시 불러오거나 구성 화면에서 설정을 변경하세요.", "Tool launch is a handoff only; policy remains incomplete until manual confirmation.": "도구 실행은 인계일 뿐입니다. 직접 확인하기 전까지 정책 단계는 완료되지 않습니다.",
        "Run exact-machine preflight": "정확한 컴퓨터 사전 점검 실행", "Patched artifact verified": "패치된 아티팩트 검증 완료", "No BIOS flash has occurred.": "BIOS는 아직 플래시하지 않았습니다.", "Deployment package destination": "배포 패키지 대상 경로",
        "Choose an empty destination folder": "빈 대상 폴더를 선택하세요", "Choose folder": "폴더 선택", "Export package": "패키지 내보내기", "Package exported — manual handoff next": "패키지 내보냄 — 다음은 수동 인계",
        "Manual boundaries remain explicit": "수동 작업 범위를 명확히 유지", "Vendor flash, setup values, returned boot, and NVIDIA policy are never inferred from a local click.": "버튼을 눌렀다는 이유만으로 제조사 플래시, 설정값, 재부팅 결과, NVIDIA 정책이 완료됐다고 판단하지 않습니다.",
        MANUAL: "수동", "Vendor flash": "제조사 플래시", "Select the exported artifact in the documented vendor utility. Keep power stable.": "문서에 지정된 제조사 유틸리티에서 내보낸 아티팩트를 선택하세요. 전원이 끊기지 않도록 주의해야 합니다.",
        PHYSICAL: "물리 작업", "Recovery readiness": "복구 준비", "Keep the pinned recovery route and original image available before flashing.": "플래시하기 전에 고정된 복구 경로와 원본 이미지를 바로 쓸 수 있게 준비하세요.",
        "UEFI values": "UEFI 설정값", "Confirm Above 4G Decoding and Resizable BAR in firmware. The app does not change them.": "펌웨어에서 Above 4G Decoding과 Resizable BAR를 확인하세요. 앱은 이 값을 변경하지 않습니다.",
        "IMMEDIATE RESTART": "즉시 다시 시작", "Restart Windows into firmware setup?": "Windows를 다시 시작해 펌웨어 설정으로 들어갈까요?", "It does not flash firmware or change setup values.": "이 작업은 펌웨어를 플래시하거나 설정값을 바꾸지 않습니다.",
        "I saved and closed my work.": "작업을 저장하고 열려 있던 프로그램을 닫았습니다.", "The restart is immediate. Applications are not explicitly force-closed.": "즉시 다시 시작합니다. 앱을 강제로 닫는 옵션은 사용하지 않습니다.", "Restart to firmware UI": "펌웨어 UI로 다시 시작",
        "It cannot prove the external operation automatically.": "외부 작업의 완료 여부를 자동으로 증명할 수는 없습니다.", "I completed and independently reviewed this exact step.": "이 단계를 완료하고 결과를 직접 검토했습니다.",
        "The token is bound to this profile, active step, and plan revision.": "확인 토큰은 이 프로필, 현재 단계, 계획 리비전에만 유효합니다.", "Record completed step": "완료한 단계 기록", "RESTART REQUEST · PLAN DOES NOT ADVANCE": "재시작 요청 · 계획은 진행되지 않음",
        "Restart Windows after configuration?": "구성을 마친 뒤 Windows를 다시 시작할까요?", "A later Windows boot must be verified separately.": "다음 Windows 부팅은 별도로 검증해야 합니다.", "The command omits /f and the restart request itself does not complete this step.": "명령에 /f를 넣지 않습니다. 재시작 요청만으로는 이 단계가 완료되지 않습니다.",
        "Request restart": "재시작 요청", "Discard unsaved edits and refresh hardware?": "저장하지 않은 변경 사항을 버리고 하드웨어 정보를 새로 고칠까요?",
        "Use Configure or retry after reloading the exact profile.": "구성 화면을 사용하거나 정확한 프로필을 다시 불러온 뒤 재시도하세요.", bytes: "바이트", Blocked: "차단됨",
        "The analyzer could not prove a safe match.": "분석기가 안전한 일치를 입증하지 못했습니다.", "Pinning profile…": "프로필을 고정하는 중…", "Preflight & export": "사전 점검 및 내보내기",
        "Refuse drift, prepare the Rust firmware artifact, and export a read-back verified package.": "변경이 감지되면 중단하고 Rust 펌웨어 아티팩트를 준비한 뒤 다시 읽어 검증한 패키지를 내보냅니다.",
        "Deployment complete": "배포 완료", "Only this step can advance the durable plan. Completed receipts survive reload.": "현재 단계만 영구 배포 계획을 진행할 수 있습니다. 완료 영수증은 다시 불러와도 유지됩니다.",
        "No remaining step is ready; every gate has durable evidence.": "남은 단계가 없습니다. 모든 단계에 영구 증거가 있습니다.", "Deployment plan": "배포 계획",
        "Verify the pinned machine, topology, BIOS, and source image": "고정된 컴퓨터, 하드웨어 구성, BIOS, 원본 이미지 검증",
        "Confirm the pinned firmware recovery route": "고정된 펌웨어 복구 경로 확인", "Preserve and hash the exact original firmware image": "정확한 원본 펌웨어 이미지 보존 및 해시",
        "Build and verify the Rust DXE driver": "Rust DXE 드라이버 빌드 및 검증", "Inject and verify the patched firmware artifact": "패치된 펌웨어 아티팩트 삽입 및 검증",
        "Flash with the documented vendor route": "문서에 지정된 제조사 경로로 플래시", "Confirm firmware setup values": "펌웨어 설정값 확인",
        "Boot Windows after the firmware handoff": "펌웨어 인계 후 Windows 부팅", "Verify the firmware driver status": "펌웨어 드라이버 상태 검증",
        "Write and read back the NvStrapsReBar configuration": "NvStrapsReBar 구성 기록 및 다시 읽기", "Restart after configuration": "구성 후 다시 시작",
        "Observe Resizable BAR through NVIDIA telemetry": "NVIDIA 텔레메트리로 Resizable BAR 확인", "Configure NVIDIA application profiles": "NVIDIA 애플리케이션 프로필 구성",
        "Apply the profile's legacy-board patch bundle": "프로필의 레거시 보드 패치 묶음 적용", "Use only the pinned vendor route and exported artifact.": "고정된 제조사 경로와 내보낸 아티팩트만 사용하세요.",
        "Confirm only after the vendor tool reports success; this is an operator attestation, not automatic flash verification.": "제조사 도구가 성공을 보고한 뒤에만 확인하세요. 이는 작업자 확인이며 자동 플래시 검증이 아닙니다.",
        "Keep the pinned recovery route available and do not interrupt power during the flash.": "고정된 복구 경로를 준비하고 플래시 중에는 전원이 끊기지 않게 하세요.",
        "Enable native ReBAR and Above 4G decoding, and disable CSM.": "네이티브 ReBAR와 Above 4G decoding을 켜고 CSM을 끄세요.", "Confirm only after saving these exact firmware setup values.": "정확한 펌웨어 설정값을 저장한 뒤에만 확인하세요.",
        "Enable Above 4G decoding and disable CSM; do not claim native motherboard ReBAR.": "Above 4G decoding을 켜고 CSM을 끄세요. 메인보드 네이티브 ReBAR로 기록하면 안 됩니다.",
        "Confirm only after applying and independently reviewing the intended per-application ReBAR policy.": "의도한 앱별 ReBAR 정책을 적용하고 직접 검토한 뒤에만 확인하세요.",
        "Installing or launching NVIDIA Profile Inspector does not satisfy this step.": "NVIDIA Profile Inspector를 설치하거나 실행하는 것만으로는 이 단계가 완료되지 않습니다.",
        "This sends": "다음 명령을 실행합니다:", "This records a durable attestation for only": "다음 단계에 대해서만 영구 확인을 기록합니다:",
        "OPERATOR ATTESTATION": "작업자 확인", REVISION: "리비전",
        "For each selected risk, describe this exact image and include fingerprint": "선택한 위험 항목마다 이 이미지의 상황을 설명하고 다음 지문을 포함하세요:",
        "Manual gate recorded in the durable deployment plan.": "수동 단계를 영구 배포 계획에 기록했습니다.", "Current boot and Rust DXE verified": "현재 부팅과 Rust DXE 검증 완료",
        "Current Windows boot and Rust DXE status were durably verified.": "현재 Windows 부팅과 Rust DXE 상태를 영구 증거로 검증했습니다.", "Configuration write verified by read-back": "다시 읽어 구성 기록 검증 완료",
        "Guarded deployment configuration was written and verified by read-back.": "보호된 배포 구성을 기록하고 다시 읽어 검증했습니다.", "Configuration restart previewed; the plan did not advance.": "구성 후 재시작을 미리 확인했습니다. 계획은 진행되지 않았습니다.",
        "Configuration restart request accepted": "구성 후 재시작 요청 수락됨", "Windows accepted the restart request; this did not complete the reboot gate.": "Windows가 재시작 요청을 수락했습니다. 재시작 단계가 완료된 것은 아닙니다.",
        "Returned Windows boot verified": "돌아온 Windows 부팅 검증 완료", "A Windows boot after the configuration read-back was durably verified.": "구성을 다시 읽은 뒤 Windows가 부팅된 사실을 영구 증거로 검증했습니다.",
        "Resizable BAR independently verified": "Resizable BAR 독립 검증 완료", "NVIDIA BAR1 evidence captured and matched to this profile.": "NVIDIA BAR1 증거를 수집해 이 프로필과 일치하는지 확인했습니다.",
        "Choose and inspect the exact firmware image first.": "먼저 정확한 펌웨어 이미지를 선택하고 검사하세요.", "Source firmware read and hashed. No firmware was modified.": "원본 펌웨어를 읽고 해시했습니다. 펌웨어는 수정하지 않았습니다.",
        "Analyze this exact firmware image before selecting legacy rules.": "레거시 규칙을 선택하기 전에 정확한 펌웨어 이미지를 분석하세요.", "Wait for the exact-image analysis to finish.": "정확한 이미지 분석이 끝날 때까지 기다리세요.",
        "Exact-image legacy analysis completed read-only. No firmware was modified.": "정확한 이미지의 레거시 분석을 읽기 전용으로 마쳤습니다. 펌웨어는 수정하지 않았습니다.",
        "Legacy selections are pinned to this firmware fingerprint and ready for profile creation.": "레거시 선택 항목을 이 펌웨어 지문에 고정했습니다. 프로필을 만들 수 있습니다.",
        "Pinned Above 4G decoding compatibility rule": "고정된 Above 4G decoding 호환성 규칙", "DSDT resource-window compatibility patch": "DSDT 리소스 창 호환성 패치",
        "Compressed vendor-specific compatibility patch": "압축된 제조사 전용 호환성 패치", "The compressed section cannot be proven safe by this build.": "이 빌드에서는 압축 섹션의 안전성을 입증할 수 없습니다.",
        "Use M-FLASH to select the exported vendor-format image. The app does not perform the flash.": "M-FLASH에서 내보낸 제조사 형식 이미지를 선택하세요. 앱이 직접 플래시하지는 않습니다.",
        "MSI Flash BIOS Button recovery: MSI.ROM at USB root, rear Flash BIOS port, physical button.": "MSI Flash BIOS Button 복구: USB 루트의 MSI.ROM, 후면 Flash BIOS 포트, 물리 버튼을 사용합니다.",
        "Machine-bound profile created; the exact source image was preserved.": "이 컴퓨터에 고정된 프로필을 만들고 정확한 원본 이미지를 보존했습니다.",
        "Rust driver injected and the patched artifact verified. Nothing was flashed.": "Rust 드라이버를 삽입하고 패치된 아티팩트를 검증했습니다. 플래시는 실행하지 않았습니다.",
        "Current manual consequence preview loaded; nothing was completed.": "현재 수동 작업의 결과를 불러왔습니다. 아직 완료된 단계는 없습니다.",
        "Windows is not running in UEFI mode; firmware variables are unavailable.": "Windows가 UEFI 모드로 실행 중이 아니어서 펌웨어 변수를 사용할 수 없습니다.",
        "Administrator access is required to read or save UEFI settings.": "UEFI 설정을 읽거나 저장하려면 관리자 권한이 필요합니다.",
        "No NVIDIA display adapters were detected.": "NVIDIA 디스플레이 어댑터가 감지되지 않았습니다.",
        "S3 resume reconfiguration is disabled; resume behavior must be verified on this machine.": "S3 절전 복귀 시 재구성이 꺼져 있습니다. 이 컴퓨터에서 절전 복귀 동작을 직접 검증해야 합니다.",
        "The current settings do not select any detected NVIDIA GPU.": "현재 설정에서 감지된 NVIDIA GPU가 하나도 선택되지 않았습니다.",
        "ACTIVE STEP": "현재 단계", "global mode": "전역 모드", "target selector": "대상 선택값", "skip S3": "S3 건너뛰기", "mask override": "마스크 재정의", "setup guard": "설정 보호",
        General: "일반", "DSDT modification": "DSDT 수정", "NVRAM whitelist change": "NVRAM 허용 목록 변경", "USB controller blacklist": "USB 컨트롤러 차단 목록", "Experimental X79 patch": "실험적 X79 패치",
        Automated: "자동", "Physical confirmation": "물리 작업 확인", "Manual firmware gate": "수동 펌웨어 단계", "Verified external tool": "검증된 외부 도구", "Restart gate": "재시작 단계", completed: "완료", ready: "진행 가능", pending: "대기", applicable: "적용 가능", absent: "없음", blocked: "차단", source: "원본", section: "섹션", Requires: "필요 위험",
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
        return locale === "ko" ? `정확히 ${count}개 일치` : `${count} exact ${value === 1 ? "match" : "matches"}`;
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
        const operator = normalized.match(/^Operator attestation persisted at (.+)\.$/); if (operator) return `작업자 확인을 ${operator[1]}에 저장했습니다.`;
        const detail = normalized.match(/^(.*) · (.*)\. The volatile status proved this boot and advanced both boot and driver gates\.$/); if (detail) return `${detail[1]} · ${detail[2]}. 휘발성 상태로 현재 부팅을 입증해 부팅 및 드라이버 단계를 진행했습니다.`;
        const saved = normalized.match(/^(\d+) bytes · saved (.+)\. A Windows restart is still required\.$/); if (saved) return `${saved[1]}바이트 · ${saved[2]}에 저장. Windows를 다시 시작해야 합니다.`;
        if (normalized === "Plan advanced: false. Return after Windows boots, then verify the later boot separately.") return "계획 진행: false. Windows가 부팅되면 돌아와 해당 부팅을 별도로 검증하세요.";
        const boot = normalized.match(/^Boot (.+) is later than configuration read-back (.+)\.$/); if (boot) return `부팅 시각 ${boot[1]}은 구성 다시 읽기 시각 ${boot[2]}보다 늦습니다.`;
        const bar = normalized.match(/^All profile GPUs observed · XML (.+)\.$/); if (bar) return `프로필의 모든 GPU 확인 · XML ${bar[1]}.`;
        const driverStatus = normalized.match(/^Driver status could not be read: (.+)$/); if (driverStatus) return `드라이버 상태를 읽지 못했습니다: ${driverStatus[1]}`;
        const machineIdentity = normalized.match(/^Machine identity could not be pinned: (.+)$/); if (machineIdentity) return `컴퓨터 식별 정보를 고정하지 못했습니다: ${machineIdentity[1]}`;
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
