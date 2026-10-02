import type { ReactNode, Ref } from "react";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./icons";

/** Presentational pieces of the guided interface (design system nv- classes). */

export const StatusChip = ({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) => (
        <span className="nv-chip" role="status">
                <i className={`nv-dot${tone === "muted" ? "" : ` ${tone}`}`} aria-hidden="true" />
                {children}
        </span>
);

export type StageNumber = 1 | 2 | 3 | 4 | 5;

const stageIds = [
        ["ui.stagePrepare", "ui.stagePrepareDetail"],
        ["ui.stageInstall", "ui.stageInstallDetail"],
        ["ui.stageTurnOn", "ui.stageTurnOnDetail"],
        ["ui.stageFinish", "ui.stageFinishDetail"],
] as const;

/** Passive progress output. It is never navigation. */
export const StageTracker = ({ current, note }: { current: StageNumber; note?: ReactNode }) => {
        const { t } = useI18n();
        return (
                <aside className="nv-stages" aria-label={t("ui.setupProgress")}>
                        <ol>
                                {stageIds.map(([nameId, detailId], index) => {
                                        const number = index + 1;
                                        const state = number < current ? "done" : number === current ? "current" : "todo";
                                        return (
                                                <li key={nameId} className={`nv-stage ${state}`} aria-current={state === "current" ? "step" : undefined}>
                                                        <span className="nv-stage-mark" aria-hidden="true">{state === "done" ? <Icon name="check" /> : number}</span>
                                                        <span className="nv-stage-name">{number} {t(nameId)}</span>
                                                        <span className="nv-stage-sub">
                                                                {t(state === "done" ? "ui.stageStateDone" : state === "current" ? "ui.stageStateNow" : "ui.stageStateNext")} · {t(detailId)}
                                                        </span>
                                                </li>
                                        );
                                })}
                        </ol>
                        <p className="nv-stages-note"><Icon name="info" /><span>{note ?? t("ui.closeAndContinueLater")}</span></p>
                </aside>
        );
};

export type ActionBarProps = {
        hint?: ReactNode;
        primary?: {
                label: ReactNode;
                onClick: () => void;
                icon?: IconName;
                disabled?: boolean;
                busy?: boolean;
                buttonRef?: Ref<HTMLButtonElement>;
        };
        secondary?: { label: ReactNode; onClick: () => void; disabled?: boolean }[];
        center?: boolean;
};

/** The primary action always sits at the far right of the same bar. */
export const ActionBar = ({ hint, primary, secondary = [], center = false }: ActionBarProps) => (
        <footer className={center ? "nv-actionbar nv-actionbar-center" : "nv-actionbar"}>
                <p className="nv-actionbar-hint">{hint}</p>
                <div className="nv-actionbar-actions">
                        {secondary.map((action, index) => (
                                <button key={index} type="button" className="nv-btn nv-btn-text" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>
                        ))}
                        {primary && (
                                <button
                                        ref={primary.buttonRef}
                                        type="button"
                                        className="nv-btn nv-btn-primary"
                                        disabled={primary.disabled || primary.busy}
                                        aria-busy={primary.busy || undefined}
                                        onClick={primary.onClick}
                                >
                                        {primary.busy && <span className="nv-spinner" aria-hidden="true" />}
                                        {primary.label}
                                        {primary.icon && !primary.busy && <Icon name={primary.icon} />}
                                </button>
                        )}
                </div>
        </footer>
);

export const TaskHead = ({ label, title, lead, titleRef }: { label?: ReactNode; title: ReactNode; lead?: ReactNode; titleRef?: Ref<HTMLHeadingElement> }) => (
        <div className="nv-task-head">
                {label && <p className="nv-step-label">{label}</p>}
                <h1 className="nv-title" ref={titleRef} tabIndex={-1}>{title}</h1>
                {lead && <p className="nv-lead">{lead}</p>}
        </div>
);

/** One install screen: stage label, heading, body, and the fixed action bar. */
export const TaskPanel = ({ label, title, lead, children, bar, titleRef }: {
        label: ReactNode;
        title: ReactNode;
        lead?: ReactNode;
        children?: ReactNode;
        bar: ReactNode;
        titleRef?: Ref<HTMLHeadingElement>;
}) => (
        <main className="nv-task" data-testid="install-task">
                <div className="nv-task-scroll">
                        <div className="nv-task-body">
                                <TaskHead label={label} title={title} lead={lead} titleRef={titleRef} />
                                {children}
                        </div>
                </div>
                {bar}
        </main>
);

export const Steps = ({ children, label }: { children: ReactNode; label?: string }) => (
        <ol className="nv-steps" aria-label={label}>{children}</ol>
);

export const Step = ({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children?: ReactNode }) => (
        <li>
                <span>
                        <span className="nv-strong">{title}</span>
                        {detail && <><br /><span className="nv-supporting">{detail}</span></>}
                        {children}
                </span>
        </li>
);

export const Fact = ({ icon, title, detail, tone }: { icon: IconName; title: ReactNode; detail?: ReactNode; tone?: "ok" | "warn" }) => (
        <li className={tone ? `nv-fact ${tone}` : "nv-fact"}>
                <Icon name={icon} />
                <span className="nv-fact-text">
                        <span className="nv-strong">{title}</span>
                        {detail && <span className="nv-supporting">{detail}</span>}
                </span>
        </li>
);

export const Facts = ({ children }: { children: ReactNode }) => <ul className="nv-facts">{children}</ul>;

export type CheckState = "done" | "running" | "waiting" | "alert";

export const Check = ({ state, label, word }: { state: CheckState; label: ReactNode; word: ReactNode }) => (
        <li className={`nv-check ${state}`}>
                <span className="nv-check-mark" aria-hidden="true">
                        {state === "done" ? <Icon name="check" /> : state === "running" ? <span className="nv-spinner" /> : state === "alert" ? <Icon name="alert" /> : null}
                </span>
                <span>{label}</span>
                <span className="nv-check-state">{word}</span>
        </li>
);

export const Result = ({ title, detail }: { title: ReactNode; detail?: ReactNode }) => (
        <div className="nv-result" role="status">
                <Icon name="checkCircle" large />
                <div className="nv-fact-text">
                        <span className="nv-strong">{title}</span>
                        {detail && <span className="nv-supporting">{detail}</span>}
                </div>
        </div>
);

export const Notice = ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
        <div className="nv-notice" role="alert">
                <Icon name="alert" />
                <div className="nv-fact-text"><strong>{title}</strong>{children && <span>{children}</span>}</div>
        </div>
);

export const Caution = ({ title, children }: { title: ReactNode; children: ReactNode }) => (
        <div className="nv-caution" role="note">
                <Icon name="alert" />
                <div className="nv-fact-text"><strong>{title}</strong><span>{children}</span></div>
        </div>
);

export const RouteCard = ({ icon, label, title, detail }: { icon: IconName; label?: ReactNode; title: ReactNode; detail?: ReactNode }) => (
        <div className="nv-route">
                <Icon name={icon} />
                <div className="nv-fact-text">
                        {label && <span className="nv-label">{label}</span>}
                        <span className="nv-strong">{title}</span>
                        {detail && <span className="nv-supporting">{detail}</span>}
                </div>
        </div>
);

export const FileCard = ({ icon = "file", name, meta, mono = true, action }: {
        icon?: IconName;
        name: ReactNode;
        meta?: ReactNode;
        mono?: boolean;
        action?: { label: ReactNode; onClick: () => void; disabled?: boolean };
}) => (
        <div className="nv-file">
                <Icon name={icon} />
                <div className="nv-file-body">
                        <span className={mono ? "nv-mono nv-strong" : "nv-strong"}>{name}</span>
                        {meta && <span className="nv-supporting">{meta}</span>}
                </div>
                {action && <button type="button" className="nv-btn nv-btn-text" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
        </div>
);

export const ListRow = ({ icon, title, detail, onClick, disabled }: { icon: IconName; title: ReactNode; detail?: ReactNode; onClick: () => void; disabled?: boolean }) => (
        <li>
                <button type="button" className="nv-row" onClick={onClick} disabled={disabled}>
                        <Icon name={icon} />
                        <span className="nv-row-text">
                                <span className="nv-strong">{title}</span>
                                {detail && <span className="nv-supporting">{detail}</span>}
                        </span>
                        <span className="nv-row-chevron"><Icon name="chevron" /></span>
                </button>
        </li>
);

export const SizeCompare = ({ fromLabel, from, toLabel, to, achieved = false, label }: {
        fromLabel: ReactNode;
        from: string;
        toLabel: ReactNode;
        to: string;
        achieved?: boolean;
        label: string;
}) => (
        <div className="nv-compare" role="img" aria-label={label}>
                <div className="nv-compare-col"><span className="nv-label">{fromLabel}</span><span className={achieved ? "nv-value" : "nv-value from"} style={achieved ? { color: "var(--muted)" } : undefined}>{from}</span></div>
                <span className="nv-compare-arrow"><Icon name="arrow" large /></span>
                <div className="nv-compare-col"><span className="nv-label">{toLabel}</span><span className={achieved ? "nv-value achieved" : "nv-value to"}>{to}</span></div>
        </div>
);

export const GpuRow = ({ name, detail, children }: { name: ReactNode; detail?: ReactNode; children?: ReactNode }) => (
        <div className="nv-gpu">
                <Icon name="gpu" />
                <div className="nv-gpu-name"><span className="nv-strong">{name}</span>{detail && <span className="nv-supporting">{detail}</span>}</div>
                <span className="nv-sizes">{children}</span>
        </div>
);

export const Crumb = ({ here, onHome }: { here: ReactNode; onHome: () => void }) => {
        const { t } = useI18n();
        return (
                <nav className="nv-crumb" aria-label={t("ui.breadcrumb")}>
                        <button type="button" onClick={onHome}>{t("ui.home")}</button>
                        <span className="nv-muted" aria-hidden="true">›</span>
                        <span className="nv-muted">{here}</span>
                </nav>
        );
};
