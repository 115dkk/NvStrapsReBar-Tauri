import { useI18n } from "../i18n";
import { useConfigurationWorkspaceController } from "./context";
import { formatPciSelector, hasOperationalConfiguration } from "./model";

export const AutomaticPolicyPanel = () => {
        const { t } = useI18n();
        const { draft, patch } = useConfigurationWorkspaceController();
        return (
                <section className="panel">
                        <div className="section-head">
                                <div>
                                        <span className="step">01</span>
                                        <h3>{t("ui.automaticPolicy")}</h3>
                                </div>
                                <p>
                                        {t(
                                                "ui.chooseTheDefaultBehaviorBeforeAddingDeviceSpecificExceptions",
                                        )}
                                </p>
                        </div>
                        <div
                                className="mode-grid"
                                role="radiogroup"
                                aria-label={t("ui.automaticGpuPolicy")}
                        >
                                {[
                                        [
                                                0,
                                                t("ui.off"),
                                                t(
                                                        "ui.onlyExplicitGpuRulesAreUsed",
                                                ),
                                        ],
                                        [
                                                1,
                                                t("ui.builtInGpuListOnly"),
                                                t(
                                                        "ui.builtInGpuListOnlyDescription",
                                                ),
                                        ],
                                        [
                                                2,
                                                t("ui.builtInGpuListFallback"),
                                                t(
                                                        "ui.builtInGpuListFallbackDescription",
                                                ),
                                        ],
                                ].map(([v, l, d]) => (
                                        <label
                                                className={
                                                        draft.globalMode === v
                                                                ? "selected"
                                                                : ""
                                                }
                                                key={v}
                                        >
                                                <input
                                                        type="radio"
                                                        name="mode"
                                                        checked={
                                                                draft.globalMode ===
                                                                v
                                                        }
                                                        onChange={() =>
                                                                patch({
                                                                        globalMode: v as
                                                                                | 0
                                                                                | 1
                                                                                | 2,
                                                                })
                                                        }
                                                />
                                                <strong>{l}</strong>
                                                <span>{d}</span>
                                        </label>
                                ))}
                        </div>
                        {!hasOperationalConfiguration(draft) && (
                                        <div className="notice warning">
                                                {t(
                                                        "ui.automaticPolicyOffAndNoRules",
                                                )}
                                        </div>
                                )}
                        <label className="field">
                                <span>{t("ui.targetPciBarSize")}</span>
                                <select
                                        value={draft.targetPciBarSize}
                                        onChange={(e) =>
                                                patch({
                                                        targetPciBarSize:
                                                                Number(
                                                                        e.target
                                                                                .value,
                                                                ),
                                                })
                                        }
                                >
                                        <option value="0">
                                                {t("ui.defaultNoPciResize")}
                                        </option>
                                        {Array.from(
                                                {
                                                        length: 31,
                                                },
                                                (_, i) => (
                                                        <option
                                                                value={i + 1}
                                                                key={i}
                                                        >
                                                                {formatPciSelector(
                                                                        i + 1,
                                                                )}
                                                        </option>
                                                ),
                                        )}
                                        <option value="32">
                                                {t("ui.anySupportedSize")}
                                        </option>
                                        <option value="64">
                                                {t("ui.selectedGpusOnly")}
                                        </option>
                                        <option value="65">
                                                {t("ui.gpuStrapsOnly")}
                                        </option>
                                </select>
                                <small>
                                        {t(
                                                "ui.targetPciBarSizeGuidance",
                                        )}
                                </small>
                        </label>
                </section>
        );
};
