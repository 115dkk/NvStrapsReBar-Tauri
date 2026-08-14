import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
        messages,
        type MessageDescriptor,
        type MessageId,
        type MessageParameters,
        type MessageValues,
} from "./i18n-catalog";

export type Locale = "en" | "ko";
export const LANGUAGE_STORAGE_KEY = "nvstraps-rebar.ui.language";

declare global {
        interface Window { __NVSTRAPS_I18N_MISSING__?: string[] }
}

export const messageIds = Object.freeze(Object.keys(messages) as MessageId[]);

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
export function translate<Id extends keyof MessageParameters>(
        locale: Locale,
        id: Id,
        values: MessageParameters[Id],
): string;
export function translate<Id extends Exclude<MessageId, keyof MessageParameters>>(
        locale: Locale,
        id: Id,
): string;
export function translate(
        locale: Locale,
        id: MessageId,
        values?: MessageValues,
): string {
        const template = messages[id][locale];
        if (!values) return template;
        return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) =>
                Object.prototype.hasOwnProperty.call(values, key)
                        ? String(values[key])
                        : token,
        );
}

export const translateMessage = (
        locale: Locale,
        descriptor: MessageDescriptor,
): string => {
        const template = messages[descriptor.id][locale];
        if (!("values" in descriptor) || !descriptor.values) return template;
        const values: MessageValues = descriptor.values;
        return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) =>
                Object.prototype.hasOwnProperty.call(values, key)
                        ? String(values[key])
                        : token,
        );
};

type TranslateFunction = {
        <Id extends keyof MessageParameters>(id: Id, values: MessageParameters[Id]): string;
        <Id extends Exclude<MessageId, keyof MessageParameters>>(id: Id): string;
};
type I18nValue = { locale: Locale; setLocale(locale: Locale): void; t: TranslateFunction; n(value: number): string; exactMatches(value: number): string; absentRules(value: number): string; validationSummary(gpuCount: number, bytes: number): string; gpuCountLabel(value: number): string };
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
        const [locale, updateLocale] = useState<Locale>(() => resolveLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY), navigator.languages?.length ? navigator.languages : [navigator.language]));
        const setLocale = useCallback((next: Locale) => { localStorage.setItem(LANGUAGE_STORAGE_KEY, next); updateLocale(next); }, []);
        useEffect(() => {
                document.documentElement.lang = locale;
                document.title = locale === "ko" ? "NvStrapsReBar — 펌웨어 배포" : "NvStrapsReBar";
        }, [locale]);
        const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: ((id: MessageId, values?: MessageValues) => {
                const template = messages[id][locale];
                if (!values) return template;
                return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) =>
                        Object.prototype.hasOwnProperty.call(values, key)
                                ? String(values[key])
                                : token,
                );
        }) as TranslateFunction, n: (value) => formatNumber(locale, value), exactMatches: (value) => formatExactMatches(locale, value), absentRules: (value) => formatAbsentRules(locale, value), validationSummary: (gpuCount, bytes) => formatValidationSummary(locale, gpuCount, bytes), gpuCountLabel: (value) => formatGpuCountLabel(locale, value) }), [locale, setLocale]);
        return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n(): I18nValue { const value = useContext(I18nContext); if (!value) throw new Error("useI18n must be used inside I18nProvider"); return value; }
