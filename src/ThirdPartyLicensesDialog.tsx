import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "./i18n";

const pretendardLicenseUrl = new URL(
        "licenses/Pretendard/LICENSE",
        document.baseURI,
).toString();

export function ThirdPartyLicensesDialog({
        onClose,
        returnFocus,
}: {
        onClose(): void;
        returnFocus: RefObject<HTMLButtonElement | null>;
}) {
        const { t } = useI18n();
        const dialog = useRef<HTMLDivElement>(null);
        const [licenseText, setLicenseText] = useState("");
        const [loadFailed, setLoadFailed] = useState(false);

        useEffect(() => {
                const controller = new AbortController();
                void fetch(pretendardLicenseUrl, {
                        cache: "force-cache",
                        signal: controller.signal,
                })
                        .then((response) => {
                                if (!response.ok)
                                        throw new Error(
                                                `Bundled Pretendard license returned ${response.status}`,
                                        );
                                return response.text();
                        })
                        .then(setLicenseText)
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
                                <h3>{t("ui.fullLicenseText")}</h3>
                                {loadFailed ? (
                                        <p role="alert">
                                                {t(
                                                        "ui.theBundledLicenseTextCouldNotBeLoaded",
                                                )}
                                        </p>
                                ) : licenseText ? (
                                        <pre
                                                className="license-text"
                                                data-testid="pretendard-license-text"
                                                tabIndex={0}
                                        >
                                                {licenseText}
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
