import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useConfigurationWorkspaceController } from "../configuration-workspace/context";
import { useDeploymentWorkspaceController } from "../deployment-workspace/context";
import type { GameProfile } from "../game-settings/contract";
import { indexGames, searchGames, sourceMessageId } from "../game-settings/model";
import { useGameSettings, type GameSettingsController, type GamesOutcome } from "../game-settings/use-game-settings";
import { translateMessage, useI18n } from "../i18n";
import { Icon } from "./icons";
import { useGuidedNavigation } from "./navigation";
import { OPTIONAL_FINAL_STEP } from "./routing";
import { ActionBar, Crumb, FileCard, Notice, Result, SwitchRow, TaskHead } from "./ui";

type Translate = ReturnType<typeof useI18n>["t"];

const savedAt = (locale: string, unixMs: string) =>
        new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(Number(unixMs));

const outcomeText = (t: Translate, outcome: GamesOutcome) => {
        if (!outcome) return "";
        if (outcome.kind === "game") return t(outcome.on ? "ui.gameTurnedOn" : "ui.gameTurnedOff", { game: outcome.name });
        if (outcome.kind === "allGames") return t(outcome.on ? "ui.allGamesTurnedOn" : "ui.allGamesTurnedOff");
        return t("ui.gamesRestored");
};

const GameRow = ({ game, pending, disabled, onChange }: { game: GameProfile; pending: boolean | undefined; disabled: boolean; onChange: (name: string, on: boolean) => void }) => {
        const { t } = useI18n();
        const apps = game.apps.length > 1 ? t("ui.gameAppsMore", { app: game.apps[0]!, count: game.apps.length - 1 }) : game.apps[0];
        const source = sourceMessageId(game.state);
        return (
                <li>
                        <SwitchRow
                                title={game.name}
                                detail={source ? `${apps} · ${t(source)}` : apps}
                                checked={pending ?? game.state.on}
                                busy={pending !== undefined}
                                disabled={disabled}
                                onChange={(on) => onChange(game.name, on)}
                        />
                </li>
        );
};

/** One confirmation: Close on the left with focus, Escape closes, Tab stays inside, focus returns to the opener. */
const ConfirmDialog = ({ title, children, confirmLabel, onClose, onConfirm }: { title: ReactNode; children: ReactNode; confirmLabel: ReactNode; onClose: () => void; onConfirm: () => void }) => {
        const { t } = useI18n();
        const id = useId();
        const dialog = useRef<HTMLDivElement>(null);
        const close = useRef(onClose);
        close.current = onClose;
        // Read during the first render, before autoFocus moves focus into the dialog.
        const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
        useEffect(() => {
                const onKey = (event: KeyboardEvent) => {
                        if (event.key === "Escape") {
                                event.preventDefault();
                                close.current();
                                return;
                        }
                        if (event.key !== "Tab" || !dialog.current) return;
                        const controls = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
                        const first = controls[0], last = controls.at(-1);
                        if (!first || !last) return;
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
                        requestAnimationFrame(() => opener?.focus({ preventScroll: true }));
                };
        }, [opener]);
        return (
                <div className="nv-scrim" role="presentation">
                        <div ref={dialog} className="nv-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-detail`}>
                                <h2 id={`${id}-title`}>{title}</h2>
                                <p className="nv-body" id={`${id}-detail`}>{children}</p>
                                <div className="nv-dialog-actions">
                                        <button type="button" className="nv-btn nv-btn-quiet" autoFocus onClick={onClose}>{t("ui.close")}</button>
                                        <button type="button" className="nv-btn nv-btn-primary" onClick={onConfirm}>{confirmLabel}</button>
                                </div>
                        </div>
                </div>
        );
};

const AdministratorCard = () => {
        const { t } = useI18n();
        const { busy, elevate } = useConfigurationWorkspaceController();
        return (
                <section className="nv-card" aria-labelledby="games-admin">
                        <h2 className="nv-section" id="games-admin">{t("ui.gamesAdminTitle")}</h2>
                        <p className="nv-body nv-muted">{t("ui.gamesAdminDetail")}</p>
                        <div>
                                <button type="button" className="nv-btn nv-btn-primary" disabled={busy} onClick={() => void elevate()}><Icon name="key" />{t("ui.reopenAsAdministrator")}</button>
                        </div>
                </section>
        );
};

const GameSearch = ({ games, version, row }: { games: GameProfile[]; version: string; row: (game: GameProfile) => ReactNode }) => {
        const { t, n } = useI18n();
        const [query, setQuery] = useState("");
        const index = useMemo(() => indexGames(games), [games]);
        const { shown, total } = useMemo(() => searchGames(index, query), [index, query]);
        const searching = query.trim() !== "";
        return (
                <section className="nv-group" aria-labelledby="find-game">
                        <h2 className="nv-section" id="find-game">{t("ui.findGame")}</h2>
                        <input
                                type="search"
                                className="nv-input"
                                aria-labelledby="find-game"
                                aria-describedby="find-game-count"
                                placeholder={t("ui.findGamePlaceholder")}
                                autoComplete="off"
                                spellCheck={false}
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                        />
                        <p className="nv-supporting" id="find-game-count" aria-live="polite">
                                {!searching
                                        ? t("ui.gamesInDriver", { version, count: n(games.length) })
                                        : total === 0
                                                ? t("ui.gamesNoMatch")
                                                : total > shown.length
                                                        ? t("ui.gamesShownOf", { shown: n(shown.length), total: n(total) })
                                                        : t("ui.gamesFound", { count: n(total) })}
                        </p>
                        {shown.length > 0 && <ul className="nv-games" aria-labelledby="find-game">{shown.map(row)}</ul>}
                </section>
        );
};

const BackupSection = ({ games, locked }: { games: GameSettingsController; locked: boolean }) => {
        const { t, locale } = useI18n();
        if (games.load.status !== "ready") return null;
        const backup = games.load.catalog.backup;
        const date = backup ? savedAt(locale, backup.createdAtUnixMs) : "";
        return (
                <details className="nv-disclosure" data-testid="games-backup">
                        <summary><Icon name="chevron" />{t("ui.gamesBackupSummary")}</summary>
                        <div className="nv-group nv-disclosure-body">
                                {backup ? (
                                        <>
                                                <FileCard icon="archive" name={t("ui.gamesBackupName")} mono={false} meta={<><span>{t("ui.gamesBackupMeta", { date, version: backup.driverVersion })}</span><br /><span className="nv-mono">{backup.path}</span></>} />
                                                <div className="nv-button-row">
                                                        <button type="button" className="nv-btn nv-btn-quiet" disabled={locked || games.gameBusy} onClick={() => games.setDialog("restore")}><Icon name="undo" />{t("ui.gamesRestore")}</button>
                                                </div>
                                        </>
                                ) : (
                                        <p className="nv-supporting">{t("ui.gamesBackupFirst")}</p>
                                )}
                        </div>
                </details>
        );
};

/** Per-game Resizable BAR: one switch for all games, the games changed here, search, and the backup. */
export const GamesPage = ({ titleRef }: { titleRef: Ref<HTMLHeadingElement> }) => {
        const { t, locale } = useI18n();
        const games = useGameSettings();
        const { snap } = useConfigurationWorkspaceController();
        const { view, commands } = useDeploymentWorkspaceController();
        const { go } = useGuidedNavigation();
        const elevated = Boolean(snap?.platform.elevated);
        const busy = Boolean(view.busyAction);
        const canRecord = view.activeStep?.id === OPTIONAL_FINAL_STEP;
        const recorded = view.plan?.steps.find((step) => step.id === OPTIONAL_FINAL_STEP)?.state === "completed";
        const catalog = games.load.status === "ready" ? games.load.catalog : null;
        const locked = !elevated || games.bulk !== null;
        const changed = catalog ? games.kept.flatMap((name) => catalog.games.filter((game) => game.name === name)) : [];
        const row = (game: GameProfile) => <GameRow key={game.name} game={game} pending={games.pendingGames[game.name]} disabled={locked} onChange={(name, on) => void games.setGame(name, on)} />;
        const allGamesPending = games.bulk === "allGames";
        const backupDate = catalog?.backup ? savedAt(locale, catalog.backup.createdAtUnixMs) : "";
        // A confirmed dialog returns focus to a switch that is disabled while the change runs.
        useEffect(() => {
                if (games.bulk === null && document.activeElement === document.body)
                        (titleRef as RefObject<HTMLHeadingElement> | null)?.current?.focus({ preventScroll: true });
        }, [games.bulk, titleRef]);

        return (
                <>
                        <main className="nv-home" data-testid="games-page">
                                <div className="nv-task-body" style={{ paddingTop: 32, gap: 24 }}>
                                        <Crumb here={t("ui.enablePerGame")} onHome={() => go("home")} />
                                        <TaskHead title={t("ui.gamesTitle")} lead={t("ui.gamesLead")} titleRef={titleRef} />
                                        {view.activity?.tone === "error" && <Notice title={t("ui.taskDidNotFinish")}>{translateMessage(locale, view.activity.message)}</Notice>}
                                        {recorded && <Result title={t("ui.gamesRecorded")} />}
                                        {games.error && <Notice title={t("ui.taskDidNotFinish")}>{t(games.error)}</Notice>}
                                        {games.load.status === "loading" && (
                                                <div className="nv-games-loading" role="status"><span className="nv-spinner" aria-hidden="true" />{t("ui.gamesReading")}</div>
                                        )}
                                        {games.load.status === "failed" && (
                                                <>
                                                        <Notice title={t("ui.gamesReadFailed")}>{t(games.load.message)}</Notice>
                                                        <div><button type="button" className="nv-btn nv-btn-quiet" onClick={() => void games.reload()}><Icon name="restart" />{t("ui.gamesReadAgain")}</button></div>
                                                </>
                                        )}
                                        {catalog && (
                                                <>
                                                        {!elevated && <AdministratorCard />}
                                                        <SwitchRow
                                                                card
                                                                title={t("ui.allGames")}
                                                                detail={t("ui.allGamesDetail")}
                                                                checked={allGamesPending ? !catalog.allGames.on : catalog.allGames.on}
                                                                busy={allGamesPending}
                                                                disabled={locked || games.gameBusy}
                                                                onChange={games.setAllGames}
                                                        />
                                                        {changed.length > 0 && (
                                                                <section className="nv-group" aria-labelledby="games-changed">
                                                                        <h2 className="nv-section" id="games-changed">{t("ui.gamesChangedTitle")}</h2>
                                                                        <ul className="nv-games" aria-labelledby="games-changed">{changed.map(row)}</ul>
                                                                </section>
                                                        )}
                                                        <GameSearch games={catalog.games} version={catalog.driver.version} row={row} />
                                                        <BackupSection games={games} locked={locked} />
                                                </>
                                        )}
                                        <p className="nv-visually-hidden" role="status">{outcomeText(t, games.outcome)}</p>
                                </div>
                        </main>
                        <ActionBar
                                center
                                hint={t("ui.gamesHint")}
                                secondary={canRecord ? [{ label: t("ui.recordGamesDone"), onClick: commands.openManualConfirmation, disabled: busy }] : []}
                        />
                        {games.dialog === "allGames" && (
                                <ConfirmDialog title={t("ui.allGamesDialogTitle")} confirmLabel={t("ui.allGamesTurnOn")} onClose={() => games.setDialog(null)} onConfirm={() => void games.confirmAllGames()}>
                                        {t("ui.allGamesDialogDetail")}
                                </ConfirmDialog>
                        )}
                        {games.dialog === "restore" && (
                                <ConfirmDialog title={t("ui.gamesRestoreDialogTitle")} confirmLabel={t("ui.restore")} onClose={() => games.setDialog(null)} onConfirm={games.confirmRestore}>
                                        {t("ui.gamesRestoreDialogDetail", { date: backupDate })}
                                </ConfirmDialog>
                        )}
                </>
        );
};
