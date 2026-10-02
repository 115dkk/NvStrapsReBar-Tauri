import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { formatBytes } from "../configuration-workspace/model";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import { useI18n } from "../i18n";
import { Icon } from "./icons";
import { useGuidedNavigation } from "./navigation";
import { StatusChip } from "./ui";

/** Largest BAR1 among the observed GPUs, used by the status chip. */
const largestBar = (sizes: (string | null)[]) => {
        const values = sizes.filter((value): value is string => Boolean(value)).map(Number).filter(Number.isFinite);
        return values.length ? formatBytes(String(Math.max(...values))) : null;
};

export const ResizableBarChip = () => {
        const { t } = useI18n();
        const { rebarStatus } = useConfigurationWorkspaceController();
        const size = largestBar(rebarStatus.gpus.map((row) => row.gpu.bar1TotalBytes));
        switch (rebarStatus.tone) {
                case "expanded":
                        return <StatusChip tone="ok">{size ? t("ui.chipOnWithSize", { size }) : t("ui.chipOn")}</StatusChip>;
                case "legacy":
                        return <StatusChip tone="warn">{size ? t("ui.chipOffWithSize", { size }) : t("ui.chipOff")}</StatusChip>;
                case "mixed":
                        return <StatusChip tone="warn">{t("ui.chipMixed")}</StatusChip>;
                case "loading":
                        return <StatusChip tone="muted">{t("ui.chipChecking")}</StatusChip>;
                default:
                        return <StatusChip tone="warn">{t("ui.chipUnknown")}</StatusChip>;
        }
};

export const AppBar = () => {
        const { t, locale, setLocale } = useI18n();
        const navigation = useGuidedNavigation();
        const { load, busy, showConfirm, setShowLicenses, licenseButton } = useConfigurationWorkspaceController();
        const { view } = useDeploymentWorkspaceController();
        const [open, setOpen] = useState(false);
        const menuButton = useRef<HTMLButtonElement>(null);
        const menu = useRef<HTMLDivElement>(null);
        const locked = busy || showConfirm || Boolean(view.busyAction) || view.showManual || view.showReboot || view.showConfigurationReboot;
        const hasRecord = Boolean(view.plan);

        useEffect(() => {
                if (!open) return;
                menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
                const close = (event: MouseEvent) => {
                        if (!menu.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setOpen(false);
                };
                addEventListener("mousedown", close);
                return () => removeEventListener("mousedown", close);
        }, [open]);
        useEffect(() => {
                if (locked) setOpen(false);
        }, [locked]);

        const choose = (action: () => void) => {
                setOpen(false);
                menuButton.current?.focus();
                action();
        };
        const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
                const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                if (event.key === "Escape") {
                        event.preventDefault();
                        setOpen(false);
                        menuButton.current?.focus();
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
                        items[next]?.focus();
                } else if (event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        (event.key === "Home" ? items[0] : items.at(-1))?.focus();
                } else if (event.key === "Tab") {
                        setOpen(false);
                }
        };

        return (
                <header className="nv-appbar">
                        <div className="nv-brand"><Icon name="chip" /><span>NvStrapsReBar</span></div>
                        <div className="nv-appbar-spacer" />
                        <ResizableBarChip />
                        <button
                                ref={(element) => {
                                        menuButton.current = element;
                                        // The licenses dialog returns focus to the menu button.
                                        licenseButton.current = element;
                                }}
                                type="button"
                                className="nv-iconbtn"
                                aria-label={t("ui.menu")}
                                aria-haspopup="menu"
                                aria-expanded={open}
                                disabled={locked}
                                onClick={() => setOpen((value) => !value)}
                        >
                                <Icon name="more" />
                        </button>
                        {open && (
                                <div ref={menu} className="nv-menu" role="menu" aria-label={t("ui.menu")} onKeyDown={onMenuKey}>
                                        {navigation.page !== "home" && <button type="button" role="menuitem" onClick={() => choose(() => navigation.go("home"))}><Icon name="home" />{t("ui.home")}</button>}
                                        <button type="button" role="menuitem" onClick={() => choose(() => void load(true))}><Icon name="restart" />{t("ui.menuRefresh")}</button>
                                        <button type="button" role="menuitem" disabled={!hasRecord} onClick={() => choose(() => navigation.go("record"))}><Icon name="clock" />{t("ui.menuInstallRecord")}</button>
                                        <button type="button" role="menuitem" onClick={() => choose(navigation.startNewPreparation)}><Icon name="file" />{t("ui.menuNewPreparation")}</button>
                                        <button type="button" role="menuitem" disabled={view.profiles.length < 2} onClick={() => choose(() => navigation.go("profiles"))}><Icon name="folder" />{t("ui.menuOpenPreparation")}</button>
                                        <hr />
                                        <div role="group" aria-label={t("ui.language")}>
                                                <div className="nv-menu-label" aria-hidden="true">{t("ui.language")}</div>
                                                {([["en", "English"], ["ko", "한국어"]] as const).map(([value, label]) => (
                                                        <button key={value} type="button" role="menuitemradio" aria-checked={locale === value} lang={value} onClick={() => choose(() => setLocale(value))}>
                                                                <Icon name={locale === value ? "check" : "globe"} />{label}
                                                        </button>
                                                ))}
                                        </div>
                                        <hr />
                                        <button type="button" role="menuitem" onClick={() => choose(() => setShowLicenses(true))}><Icon name="doc" />{t("ui.licenses")}</button>
                                </div>
                        )}
                </header>
        );
};
