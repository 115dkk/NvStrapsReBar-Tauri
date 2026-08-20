import { describe, expect, it } from "vitest";
import { messages } from "./i18n-catalog";
import {
        formatGpuCountLabel,
        formatNumber,
        resolveLocale,
        translate,
        messageIds,
} from "./i18n";
import { stepTitleIds } from "./deployment-workspace/messages";

const guardedSources = import.meta.glob(
        [
                "./**/*.ts",
                "./**/*.tsx",
                "!./**/*.test.ts",
                "!./**/*.test.tsx",
                "!./i18n-catalog.ts",
        ],
        { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

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
                expect(formatGpuCountLabel("en", 2)).toBe("NVIDIA GPUs");
                expect(formatGpuCountLabel("ko", 2)).toBe("감지된 NVIDIA GPU");
        });

        it("formats typed messages without using display text as a key", () => {
                expect(translate("ko", "ui.ruleMatchScope", { rule: 3 })).toBe(
                        "3번 규칙 일치 범위",
                );
                expect(
                        translate("ko", "ui.editorProcessLaunched", {
                                processId: 4171,
                        }),
                ).toBe(
                        "편집기 프로세스 4171 실행됨 · 다음: 정책을 편집하고 결과를 기록하세요.",
                );
                expect(
                        translate("ko", "ui.legacyProfileCreated", {
                                ruleCount: 2,
                        }),
                ).toContain("규칙 2개");
                expect(
                        translate("ko", "ui.hardwareCheckDifferences", {
                                differenceCount: 1,
                        }),
                ).toContain("1개 항목");
        });

        it("has complete non-empty English and Korean catalogs", () => {
                expect(messageIds.length).toBeGreaterThan(350);
                for (const id of messageIds) {
                        expect(messages[id].en.trim()).not.toBe("");
                        expect(messages[id].ko.trim()).not.toBe("");
                }
        });

        it("uses factual copy instead of accuracy or safety claims", () => {
                const english = Object.values(messages).map((entry) => entry.en);
                const korean = Object.values(messages).map((entry) => entry.ko);
                for (const copy of [
                        "EXACT MACHINE / RECOVERABLE ARTIFACT",
                        "Exact firmware image",
                        "Exact MSI board recognized",
                        "NO AUTO-FLASH",
                        "Backend-recommended deployment configuration",
                        "All plan steps have receipts.",
                        "Pinned compatibility rule",
                        "Machine preflight",
                        "Preflight & export",
                        "Manual boundary",
                        "Create machine-bound profile",
                        "OPERATOR ATTESTATION",
                ])
                        expect(english).not.toContain(copy);
                for (const copy of [
                        "정확한 컴퓨터 / 복구 가능한 아티팩트",
                        "정확한 펌웨어 이미지",
                        "정확한 MSI 보드 확인됨",
                        "자동 플래시 안 함",
                        "백엔드 권장 배포 구성",
                        "고정된 호환성 규칙",
                        "컴퓨터 사전 점검",
                        "사전 점검 및 내보내기",
                        "수동 작업 범위",
                ])
                        expect(korean).not.toContain(copy);
        });

        it("uses a fact-first motherboard capability label in both locales", () => {
                expect(translate("en", "ui.motherboardResizableBarSupport")).toBe(
                        "Motherboard native ReBAR:",
                );
                expect(translate("ko", "ui.motherboardResizableBarSupport")).toBe(
                        "메인보드 자체 ReBAR:",
                );
                expect(
                        translate("ko", "ui.motherboardResizableBarSupportState", {
                                status: "지원됨",
                        }),
                ).toBe("메인보드 자체 ReBAR: 지원됨");
        });

        it("maps every deployment step from StepId rather than a wire title", () => {
                expect(Object.keys(stepTitleIds)).toHaveLength(14);
                for (const id of Object.values(stepTitleIds)) {
                        expect(translate("en", id)).not.toBe(id);
                        expect(translate("ko", id)).not.toBe(id);
                }
        });

        it("guards renderer code against English-keyed localization and behavior", () => {
                expect(Object.keys(guardedSources)).toEqual(
                        expect.arrayContaining([
                                "./App.tsx",
                                "./DeploymentWorkspace.tsx",
                                "./bridge.ts",
                                "./deployment-workspace/session.ts",
                                "./deployment-workspace/preview-adapter.ts",
                                "./deployment-workspace/tauri-adapter.ts",
                                "./hardware-support.ts",
                                "./resizable-bar-status.ts",
                        ]),
                );
                for (const [file, source] of Object.entries(guardedSources)) {
                        expect(source, `${file} uses a display string as a translation key`).not.toMatch(
                                /\bt\(\s*["'`](?!ui\.)/,
                        );
                        expect(source, `${file} compares behavior with English display text`).not.toMatch(
                                /(?:===|!==|\bcase)\s*["'`][A-Z][A-Za-z]+(?:\s+[A-Za-z]+)+/,
                        );
                        expect(source, `${file} searches behavior with English display text`).not.toMatch(
                                /\.(?:includes|startsWith|endsWith)\(\s*["'`][A-Z][^"'`]*\s+[^"'`]*/,
                        );
                }
        });
});
