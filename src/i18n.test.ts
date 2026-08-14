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
                expect(translate("ko", "S3 resume reconfiguration is disabled; resume behavior must be verified on this machine.")).toContain("S3 절전 복귀");
                expect(translate("ko", "The current settings do not select any detected NVIDIA GPU.")).toContain("하나도 선택되지 않았습니다");
        });

        it("has a non-empty Korean value for every English catalog source", () => {
                expect(translatedSources.length).toBeGreaterThan(250);
                for (const source of translatedSources) {
                        expect(translate("en", source)).toBe(source);
                        expect(translate("ko", source).trim()).not.toBe("");
                }
        });
});
