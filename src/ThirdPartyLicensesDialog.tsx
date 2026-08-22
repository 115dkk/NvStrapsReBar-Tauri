import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "./i18n";

const pretendardLicenseUrl = new URL(
        "licenses/Pretendard/LICENSE",
        document.baseURI,
).toString();
const jetendardLicenseUrl = new URL(
        "licenses/Jetendard/LICENSE",
        document.baseURI,
).toString();
const lzmaSdkRsLicenseUrl = new URL(
        "licenses/lzma-sdk-rs/LICENSE",
        document.baseURI,
).toString();

type LicenseId = "pretendard" | "jetendard" | "lzmaSdkRs";

export function ThirdPartyLicensesDialog({
        onClose,
        returnFocus,
}: {
        onClose(): void;
        returnFocus: RefObject<HTMLButtonElement | null>;
}) {
        const { t } = useI18n();
        const dialog = useRef<HTMLDivElement>(null);
        const [selectedLicense, setSelectedLicense] =
                useState<LicenseId>("pretendard");
        const [licenseText, setLicenseText] = useState<Record<LicenseId, string>>({
                pretendard: "",
                jetendard: "",
                lzmaSdkRs: "",
        });
        const [loadFailed, setLoadFailed] = useState(false);

        useEffect(() => {
                const controller = new AbortController();
                void Promise.all(
                        [
                                ["pretendard", pretendardLicenseUrl],
                                ["jetendard", jetendardLicenseUrl],
                                ["lzmaSdkRs", lzmaSdkRsLicenseUrl],
                        ].map(async ([id, url]) => {
                                const response = await fetch(url, {
                                        cache: "force-cache",
                                        signal: controller.signal,
                                });
                                if (!response.ok)
                                        throw new Error(
                                                `Bundled ${id} license returned ${response.status}`,
                                        );
                                return [id, await response.text()] as const;
                        }),
                )
                        .then((licenses) =>
                                setLicenseText(
                                        Object.fromEntries(licenses) as Record<
                                                LicenseId,
                                                string
                                        >,
                                ),
                        )
                        .catch((error: unknown) => {
                                if (
                                        !(error instanceof DOMException) ||
                                        error.name !== "AbortError"
                                )
                                        setLoadFailed(true);
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
                        const controls = [
                                ...dialog.current.querySelectorAll<HTMLElement>(
                                        'button:not([disabled]), [tabindex="0"]',
                                ),
                        ];
                        if (!controls.length) return;
                        const first = controls[0];
                        const last = controls.at(-1)!;
                        if (
                                event.shiftKey &&
                                document.activeElement === first
                        ) {
                                event.preventDefault();
                                last.focus();
                        } else if (
                                !event.shiftKey &&
                                document.activeElement === last
                        ) {
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
                <div className="modal-backdrop" role="presentation">
                        <div
                                ref={dialog}
                                className="modal license-modal"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="licenses-title"
                        >
                                <div className="license-modal-head">
                                        <div>
                                                <span className="kicker">
                                                        {t("ui.thirdPartySoftware")}
                                                </span>
                                                <h2 id="licenses-title">
                                                        {t("ui.openSourceLicenses")}
                                                </h2>
                                        </div>
                                        <button
                                                className="quiet"
                                                autoFocus
                                                onClick={onClose}
                                        >
                                                {t("ui.close")}
                                        </button>
                                </div>
                                <p>
                                        {t(
                                                "ui.pretendardV139IsBundledWithThisApplicationUnderTheSilOpenFontLicense11",
                                        )}
                                </p>
                                <p>
                                        {t(
                                                "ui.jetendardV010IsBundledForTechnicalInformationUnderTheSilOpenFontLicense11",
                                        )}
                                </p>
                                <p>
                                        {t(
                                                "ui.lzmaSdkRsV023011IsBundledUnderTheBsd3ClauseLicense",
                                        )}
                                </p>
                                <div className="license-attribution-list">
                                        <div className="license-attribution">
                                                <strong>Pretendard v1.3.9</strong>
                                                <span>
                                                        Copyright (c) 2021, Kil
                                                        Hyung-jin
                                                </span>
                                                <span>
                                                        Reserved Font Name
                                                        &apos;Pretendard&apos;
                                                </span>
                                        </div>
                                        <div className="license-attribution">
                                                <strong>Jetendard v0.1.0</strong>
                                                <span>
                                                        Copyright (c) 2026 Jung
                                                        Woong Park
                                                </span>
                                                <span>
                                                        Reserved Font Name
                                                        &apos;Jetendard&apos;
                                                </span>
                                        </div>
                                        <div className="license-attribution">
                                                <strong>
                                                        lzma-sdk-rs 0.2301.1
                                                </strong>
                                                <span>
                                                        Copyright (c) 2026 Dani
                                                        Sarfati
                                                </span>
                                                <span>
                                                        {t(
                                                                "ui.basedOnTheSevenZipSdkPublicDomain",
                                                        )}
                                                </span>
                                        </div>
                                </div>
                                <h3>{t("ui.fullLicenseText")}</h3>
                                <div
                                        className="license-picker"
                                        role="group"
                                        aria-label={t("ui.fullLicenseText")}
                                >
                                        <button
                                                type="button"
                                                aria-pressed={
                                                        selectedLicense ===
                                                        "pretendard"
                                                }
                                                onClick={() =>
                                                        setSelectedLicense(
                                                                "pretendard",
                                                        )
                                                }
                                        >
                                                {t("ui.pretendardLicense")}
                                        </button>
                                        <button
                                                type="button"
                                                aria-pressed={
                                                        selectedLicense ===
                                                        "jetendard"
                                                }
                                                onClick={() =>
                                                        setSelectedLicense(
                                                                "jetendard",
                                                        )
                                                }
                                        >
                                                {t("ui.jetendardLicense")}
                                        </button>
                                        <button
                                                type="button"
                                                aria-pressed={
                                                        selectedLicense ===
                                                        "lzmaSdkRs"
                                                }
                                                onClick={() =>
                                                        setSelectedLicense(
                                                                "lzmaSdkRs",
                                                        )
                                                }
                                        >
                                                {t("ui.lzmaSdkRsLicense")}
                                        </button>
                                </div>
                                {loadFailed ? (
                                        <p role="alert">
                                                {t(
                                                        "ui.theBundledLicenseTextCouldNotBeLoaded",
                                                )}
                                        </p>
                                ) : licenseText[selectedLicense] ? (
                                        <pre
                                                className="license-text"
                                                data-testid={`${selectedLicense}-license-text`}
                                                tabIndex={0}
                                        >
                                                {licenseText[selectedLicense]}
                                        </pre>
                                ) : (
                                        <p role="status">
                                                {t(
                                                        "ui.loadingTheBundledLicenseText",
                                                )}
                                        </p>
                                )}
                        </div>
                </div>
        );
}
