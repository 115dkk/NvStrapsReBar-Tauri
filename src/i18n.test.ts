import { describe, expect, it } from "vitest";
import { formatGpuCountLabel, formatNumber, resolveLocale, translate, translatedSources } from "./i18n";

describe("i18n locale policy", () => {
        it("prefers a valid persisted override", () => {
                expect(resolveLocale("en", ["ko-KR"])).toBe("en");
                expect(resolveLocale("ko", ["en-US"])).toBe("ko");
        });

        it("uses only the highest-priority system language", () => {
                expect(resolveLocale(null, ["en-US", "ko-KR"])).toBe("en");
                expect(resolveLocale(null, ["ko-KR", "en-US"])).toBe("ko");
                expect(resolveLocale(null, ["ja-JP", "ko-KR", "en-US"])).toBe("en");
                expect(resolveLocale("unsupported", ["en-GB"])).toBe("en");
        });

        it("formats numbers with the selected locale", () => {
                expect(formatNumber("en", 1234567)).toBe("1,234,567");
                expect(formatNumber("ko", 1234567)).toBe("1,234,567");
        });

        it("keeps protected technical values and localizes dynamic rule labels", () => {
                expect(translate("ko", "Rule 3 match scope")).toBe("3번 규칙 일치 범위");
                expect(translate("ko", "SHA-256 ABCD1234")).toBe("SHA-256 ABCD1234");
        });

        it("localizes GPU counts and known backend notices while preserving details", () => {
                expect(formatGpuCountLabel("en", 2)).toBe("NVIDIA GPUs");
                expect(formatGpuCountLabel("ko", 2)).toBe("감지된 NVIDIA GPU");
                expect(translate("ko", "Windows is not running in UEFI mode; firmware variables are unavailable.")).toContain("UEFI 모드");
                expect(translate("ko", "Administrator access is required to read or save UEFI settings.")).toContain("관리자 권한");
                expect(translate("ko", "No NVIDIA display adapters were detected.")).toContain("감지되지 않았습니다");
                expect(translate("ko", "Driver status could not be read: access denied (0x5)")).toBe("드라이버 상태를 읽지 못했습니다: access denied (0x5)");
                expect(translate("ko", "Machine identity could not be pinned: SMBIOS unavailable")).toBe("컴퓨터 식별 정보를 고정하지 못했습니다: SMBIOS unavailable");
                expect(translate("ko", "S3 resume reconfiguration is disabled. Test S3 resume on this computer.")).toContain("S3 절전 복귀");
                expect(translate("ko", "The current settings do not select any detected NVIDIA GPU.")).toContain("하나도 선택되지 않았습니다");
        });

        it("has a non-empty Korean value for every English catalog source", () => {
                expect(translatedSources.length).toBeGreaterThan(250);
                for (const source of translatedSources) {
                        expect(translate("en", source)).toBe(source);
                        expect(translate("ko", source).trim()).not.toBe("");
                }
        });

        it("uses factual copy instead of accuracy or safety claims in both locales", () => {
                const forbiddenEnglish = [
                        "EXACT MACHINE / RECOVERABLE ARTIFACT",
                        "Exact firmware image",
                        "Exact MSI board recognized",
                        "NO AUTO-FLASH",
                        "Save verified by read-back",
                        "Backend-recommended deployment configuration",
                        "All plan steps have receipts.",
                        "The token is bound to this profile, active step, and plan revision.",
                        "Pinned compatibility rule",
                        "Machine preflight",
                        "Preflight & export",
                        "Manual boundary",
                        "Create machine-bound profile",
                        "OPERATOR ATTESTATION",
                        "Tool launch is a handoff only; policy remains incomplete until manual confirmation.",
                ];
                const forbiddenKorean = [
                        "정확한 컴퓨터 / 복구 가능한 아티팩트",
                        "정확한 펌웨어 이미지",
                        "정확한 MSI 보드 확인됨",
                        "자동 플래시 안 함",
                        "다시 읽어 저장 확인 완료",
                        "백엔드 권장 배포 구성",
                        "모든 계획 단계에 영수증이 있습니다.",
                        "확인 토큰은 이 프로필, 현재 단계, 계획 리비전에만 유효합니다.",
                        "고정된 호환성 규칙",
                        "컴퓨터 사전 점검",
                        "사전 점검 및 내보내기",
                        "수동 작업 범위",
                        "이 컴퓨터에 고정된 프로필 만들기",
                        "작업자 확인",
                        "도구 실행은 인계일 뿐이며 수동 확인 전까지 정책은 완료되지 않습니다.",
                ];
                for (const source of forbiddenEnglish)
                        expect(translatedSources).not.toContain(source);
                for (const copy of forbiddenKorean)
                        expect(Object.values(Object.fromEntries(translatedSources.map((source) => [source, translate("ko", source)])))).not.toContain(copy);

                expect(translate("en", "Selected firmware image")).toBe("Selected firmware image");
                expect(translate("ko", "Selected firmware image")).toBe("선택한 펌웨어 이미지");
                expect(translate("en", "Check current hardware and source image")).toBe("Check current hardware and source image");
                expect(translate("ko", "Check current hardware and source image")).toBe("현재 하드웨어 및 원본 이미지 확인");
                expect(translate("en", "Recommended deployment configuration")).toBe("Recommended deployment configuration");
                expect(translate("ko", "Recommended deployment configuration")).toBe("권장 배포 구성");
                expect(translate("en", "Create profile for this computer")).toBe("Create profile for this computer");
                expect(translate("ko", "Create profile for this computer")).toBe("이 컴퓨터의 프로필 만들기");
                expect(translate("ko", "Editor process 4171 launched · next: edit the policy and record the result.")).toBe("편집기 프로세스 4171 실행됨 · 다음: 정책을 편집하고 결과를 기록하세요.");
                expect(translate("ko", "Legacy profile created with 2 rules · source fingerprint recorded.")).toBe("레거시 프로필 생성 · 규칙 2개 · 원본 지문 기록");
                expect(translate("ko", "Hardware check found 1 difference; deployment remains blocked until the selected profile matches.")).toBe("하드웨어 확인 결과 1개 항목이 다릅니다. 선택한 프로필과 일치해야 배포를 계속할 수 있습니다.");
        });
});
