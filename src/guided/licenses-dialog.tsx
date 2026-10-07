import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n";
import type { StaticMessageId } from "../i18n-catalog";
import { Icon } from "./icons";

type License = {
        id: string;
        name: string;
        version?: string;
        license: string;
        use: StaticMessageId;
        path: string;
};

/** Every component the app ships or takes data from. Each bundled text starts with its copyright notice. */
const licenses: License[] = [
        {
                id: "pretendard",
                name: "Pretendard",
                version: "1.3.9",
                license: "SIL Open Font License 1.1",
                use: "ui.licenseUsePretendard",
                path: "licenses/Pretendard/LICENSE",
        },
        {
                id: "jetendard",
                name: "Jetendard",
                version: "0.1.0",
                license: "SIL Open Font License 1.1",
                use: "ui.licenseUseJetendard",
                path: "licenses/Jetendard/LICENSE",
        },
        {
                id: "lzmaSdkRs",
                name: "lzma-sdk-rs",
                version: "0.2301.1",
                license: "BSD 3-Clause License",
                use: "ui.licenseUseLzmaSdkRs",
                path: "licenses/lzma-sdk-rs/LICENSE",
        },
        {
                id: "nvidiaProfileInspector",
                name: "NVIDIA Profile Inspector",
                license: "MIT License",
                use: "ui.licenseUseNvidiaProfileInspector",
                path: "licenses/nvidiaProfileInspector/LICENSE",
        },
        {
                id: "nvapi",
                name: "NVAPI SDK",
                license: "MIT License",
                use: "ui.licenseUseNvapi",
                path: "licenses/NVAPI/LICENSE",
        },
];

type Texts = Record<string, string> | "failed" | null;

/**
 * Joins the hard-wrapped lines of each paragraph so the text wraps to the dialog width.
 * Rules, headings, indented lines and list items keep their breaks; the words are unchanged.
 */
const rule = /^[-=*_]{3,}\s*$/;
const ownLine = /^(\s|\d+[).]\s|\([a-z0-9]+\)\s|[-*]\s)/i;
// A heading such as PREAMBLE: capitals only, no lowercase letter.
const heading = (line: string) => /[A-Z]/.test(line) && !/[a-z]/.test(line);

export const reflow = (text: string) =>
        text
                .replace(/\r\n?/g, "\n")
                .split(/\n{2,}/)
                .map((paragraph) => {
                        const lines = paragraph.split("\n");
                        return lines
                                .map((line, index) => {
                                        if (index === 0) return line;
                                        const previous = lines[index - 1];
                                        return rule.test(line) || rule.test(previous) || heading(previous) || ownLine.test(line) ? `\n${line}` : ` ${line}`;
                                })
                                .join("");
                })
                .join("\n\n");

/** Controls Tab can reach: the summaries, Close, and the text of an open entry. */
const reachable = (root: HTMLElement) =>
        [...root.querySelectorAll<HTMLElement>("summary, button:not([disabled]), [tabindex='0']")].filter(
                (element) => element.tagName === "SUMMARY" || !element.closest("details:not([open])"),
        );

export const LicensesDialog = ({ onClose, returnFocus }: { onClose(): void; returnFocus: RefObject<HTMLButtonElement | null> }) => {
        const { t } = useI18n();
        const dialog = useRef<HTMLDivElement>(null);
        const [texts, setTexts] = useState<Texts>(null);

        useEffect(() => {
                const controller = new AbortController();
                void Promise.all(
                        licenses.map(async ({ id, path }) => {
                                const response = await fetch(new URL(path, document.baseURI), { cache: "force-cache", signal: controller.signal });
                                if (!response.ok) throw new Error(`Bundled ${id} license returned ${response.status}`);
                                return [id, await response.text()] as const;
                        }),
                )
                        .then((loaded) => setTexts(Object.fromEntries(loaded.map(([id, text]) => [id, reflow(text)]))))
                        .catch((error: unknown) => {
                                if (!(error instanceof DOMException) || error.name !== "AbortError") setTexts("failed");
                        });
                return () => controller.abort();
        }, []);

        useEffect(() => {
                const previous = document.activeElement as HTMLElement | null;
                const onKey = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                onClose();
                                return;
                        }
                        if (event.key !== "Tab" || !dialog.current) return;
                        const controls = reachable(dialog.current);
                        if (!controls.length) return;
                        const first = controls[0];
                        const last = controls.at(-1)!;
                        if (event.shiftKey && document.activeElement === first) {
                                event.preventDefault();
                                last.focus();
                        } else if (!event.shiftKey && document.activeElement === last) {
                                event.preventDefault();
                                first.focus();
                        }
                };
                addEventListener("keydown", onKey);
                return () => {
                        removeEventListener("keydown", onKey);
                        (returnFocus.current ?? previous)?.focus();
                };
        }, [onClose, returnFocus]);

        return (
                <div className="nv-scrim" role="presentation">
                        <div ref={dialog} className="nv-dialog nv-licenses" role="dialog" aria-modal="true" aria-labelledby="licenses-title">
                                <h2 id="licenses-title">{t("ui.licenses")}</h2>
                                <ul className="nv-license-list">
                                        {licenses.map((entry) => (
                                                <li key={entry.id}>
                                                        <details className="nv-disclosure nv-license">
                                                                <summary>
                                                                        <Icon name="chevron" />
                                                                        <span className="nv-row-text">
                                                                                <span className="nv-license-name">
                                                                                        {entry.name}
                                                                                        {entry.version && <span className="nv-mono">{entry.version}</span>}
                                                                                </span>
                                                                                <span className="nv-supporting">{t(entry.use)}</span>
                                                                        </span>
                                                                        <span className="nv-meta">{entry.license}</span>
                                                                </summary>
                                                                <div className="nv-license-body">
                                                                        {texts === "failed" ? (
                                                                                <p className="nv-supporting" role="alert">{t("ui.theBundledLicenseTextCouldNotBeLoaded")}</p>
                                                                        ) : texts ? (
                                                                                <p className="nv-license-text" data-testid={`${entry.id}-license-text`} tabIndex={0}>{texts[entry.id]}</p>
                                                                        ) : (
                                                                                <p className="nv-supporting" role="status">{t("ui.loadingTheBundledLicenseText")}</p>
                                                                        )}
                                                                </div>
                                                        </details>
                                                </li>
                                        ))}
                                </ul>
                                <div className="nv-dialog-actions">
                                        <button type="button" className="nv-btn nv-btn-quiet" autoFocus onClick={onClose}>{t("ui.close")}</button>
                                </div>
                        </div>
                </div>
        );
};
