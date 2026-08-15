import { useI18n } from "../i18n";
import type { GpuRule } from "../types";
import { useConfigurationWorkspaceController } from "./context";
import { formatBytes, hex, pciTargetSizes, ruleMatchesGpu } from "./model";

export const GpuRulesPanel = () => {
        const { t } = useI18n();
        const { draft, snap, add, updateRule, patch } =
                useConfigurationWorkspaceController();
        if (!snap) return null;
        return (
                <section className="panel">
                        <div className="section-head">
                                <div>
                                        <span className="step">02</span>
                                        <h3>{t("ui.detectedGpusRules")}</h3>
                                </div>
                                <p>
                                        {t(
                                                "ui.gpuRulesExplained",
                                        )}
                                </p>
                        </div>
                        {snap.devices.length === 0 ? (
                                <div className="empty">
                                        <strong>
                                                {t(
                                                        "ui.noNvidiaDisplayAdaptersDetected",
                                                )}
                                        </strong>
                                        <span>
                                                {t(
                                                        "ui.refreshAfterVerifyingTheDeviceIsPresentInWindowsDeviceManager",
                                                )}
                                        </span>
                                </div>
                        ) : (
                                snap.devices.map((g) => {
                                        const idx = draft.rules.findIndex((r) =>
                                                ruleMatchesGpu(r, g),
                                        );
                                        return (
                                                <article
                                                        className="gpu"
                                                        key={g.id}
                                                >
                                                        <div className="gpu-id">
                                                                <span className="pci">
                                                                        {g.bus
                                                                                .toString(
                                                                                        16,
                                                                                )
                                                                                .padStart(
                                                                                        2,
                                                                                        "0",
                                                                                )
                                                                                .toUpperCase()}
                                                                        :
                                                                        {g.device
                                                                                .toString(
                                                                                        16,
                                                                                )
                                                                                .padStart(
                                                                                        2,
                                                                                        "0",
                                                                                )
                                                                                .toUpperCase()}
                                                                        .
                                                                        {
                                                                                g.function
                                                                        }
                                                                </span>
                                                                <div>
                                                                        <h4>
                                                                                {
                                                                                        g.name
                                                                                }
                                                                        </h4>
                                                                        <p>
                                                                                DEV{" "}
                                                                                {hex(
                                                                                        g.deviceId,
                                                                                )}{" "}
                                                                                ·
                                                                                SUBSYS{" "}
                                                                                {hex(
                                                                                        g.subsystemDeviceId,
                                                                                )}

                                                                                :
                                                                                {hex(
                                                                                        g.subsystemVendorId,
                                                                                )}{" "}
                                                                                ·{" "}
                                                                                {formatBytes(
                                                                                        g.dedicatedVideoMemory,
                                                                                )}{" "}
                                                                                VRAM
                                                                        </p>
                                                                </div>
                                                        </div>
                                                        <div className="gpu-facts">
                                                                <span>
                                                                        {t(
                                                                                "ui.currentBarAperture",
                                                                        )}{" "}
                                                                        <b>
                                                                                {formatBytes(
                                                                                        g.currentBarSize,
                                                                                )}
                                                                        </b>
                                                                </span>
                                                                <span>
                                                                        {t(
                                                                                "ui.family",
                                                                        )}{" "}
                                                                        <b>
                                                                                {g.isTuring
                                                                                        ? "Turing"
                                                                                        : t(
                                                                                                  "ui.other",
                                                                                          )}
                                                                        </b>
                                                                </span>
                                                                <span>
                                                                        {t(
                                                                                "ui.effective",
                                                                        )}{" "}
                                                                        <b>
                                                                                {g.effectiveBarSizeSelector ===
                                                                                null
                                                                                        ? t(
                                                                                                  "ui.none",
                                                                                          )
                                                                                        : pciTargetSizes[
                                                                                                  g
                                                                                                          .effectiveBarSizeSelector
                                                                                          ]}
                                                                        </b>
                                                                </span>
                                                        </div>
                                                        {idx < 0 ? (
                                                                <button
                                                                        className="add"
                                                                        onClick={() =>
                                                                                add(
                                                                                        g,
                                                                                )
                                                                        }
                                                                        disabled={
                                                                                draft
                                                                                        .rules
                                                                                        .length >=
                                                                                8
                                                                        }
                                                                >
                                                                        +{" "}
                                                                        {t(
                                                                                "ui.addExplicitRule",
                                                                        )}
                                                                </button>
                                                        ) : (
                                                                <div className="rule">
                                                                        <label>
                                                                                {t(
                                                                                        "ui.matchScope",
                                                                                )}
                                                                                <select
                                                                                        value={
                                                                                                draft
                                                                                                        .rules[
                                                                                                        idx
                                                                                                ]
                                                                                                        .matchScope
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                updateRule(
                                                                                                        idx,
                                                                                                        {
                                                                                                                matchScope: e
                                                                                                                        .target
                                                                                                                        .value as GpuRule["matchScope"],
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <option value="device">
                                                                                                {t(
                                                                                                        "ui.deviceId",
                                                                                                )}
                                                                                        </option>
                                                                                        <option value="subsystem">
                                                                                                {t(
                                                                                                        "ui.subsystem",
                                                                                                )}
                                                                                        </option>
                                                                                        <option value="location">
                                                                                                {t(
                                                                                                        "ui.pciLocation",
                                                                                                )}
                                                                                        </option>
                                                                                </select>
                                                                        </label>
                                                                        <label>
                                                                                {t(
                                                                                        "ui.actionSize",
                                                                                )}
                                                                                <select
                                                                                        value={
                                                                                                draft
                                                                                                        .rules[
                                                                                                        idx
                                                                                                ]
                                                                                                        .barSizeSelector ??
                                                                                                ""
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                updateRule(
                                                                                                        idx,
                                                                                                        {
                                                                                                                barSizeSelector:
                                                                                                                        e
                                                                                                                                .target
                                                                                                                                .value ===
                                                                                                                        ""
                                                                                                                                ? null
                                                                                                                                : Number(
                                                                                                                                          e
                                                                                                                                                  .target
                                                                                                                                                  .value,
                                                                                                                                  ),
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <option value="">
                                                                                                {t(
                                                                                                        "ui.noExplicitSize",
                                                                                                )}
                                                                                        </option>
                                                                                        {pciTargetSizes.map(
                                                                                                (
                                                                                                        s,
                                                                                                        i,
                                                                                                ) => (
                                                                                                        <option
                                                                                                                value={
                                                                                                                        i
                                                                                                                }
                                                                                                                key={
                                                                                                                        s
                                                                                                                }
                                                                                                        >
                                                                                                                {
                                                                                                                        s
                                                                                                                }
                                                                                                        </option>
                                                                                                ),
                                                                                        )}
                                                                                        <option value="254">
                                                                                                {t(
                                                                                                        "ui.excludeGpu",
                                                                                                )}
                                                                                        </option>
                                                                                </select>
                                                                        </label>
                                                                        <label>
                                                                                {t(
                                                                                        "ui.sizeMaskOverride",
                                                                                )}
                                                                                <select
                                                                                        value={
                                                                                                draft
                                                                                                        .rules[
                                                                                                        idx
                                                                                                ]
                                                                                                        .overrideBarSizeMask ===
                                                                                                null
                                                                                                        ? "inherit"
                                                                                                        : String(
                                                                                                                  draft
                                                                                                                          .rules[
                                                                                                                          idx
                                                                                                                  ]
                                                                                                                          .overrideBarSizeMask,
                                                                                                          )
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                updateRule(
                                                                                                        idx,
                                                                                                        {
                                                                                                                overrideBarSizeMask:
                                                                                                                        e
                                                                                                                                .target
                                                                                                                                .value ===
                                                                                                                        "inherit"
                                                                                                                                ? null
                                                                                                                                : e
                                                                                                                                          .target
                                                                                                                                          .value ===
                                                                                                                                  "true",
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <option value="inherit">
                                                                                                {t(
                                                                                                        "ui.inheritGlobal",
                                                                                                )}
                                                                                        </option>
                                                                                        <option value="true">
                                                                                                {t(
                                                                                                        "ui.forceEnabled",
                                                                                                )}
                                                                                        </option>
                                                                                        <option value="false">
                                                                                                {t(
                                                                                                        "ui.forceDisabled",
                                                                                                )}
                                                                                        </option>
                                                                                </select>
                                                                        </label>
                                                                        <button
                                                                                className="remove"
                                                                                onClick={() =>
                                                                                        patch(
                                                                                                {
                                                                                                        rules: draft.rules.filter(
                                                                                                                (
                                                                                                                        _,
                                                                                                                        i,
                                                                                                                ) =>
                                                                                                                        i !==
                                                                                                                        idx,
                                                                                                        ),
                                                                                                },
                                                                                        )
                                                                                }
                                                                        >
                                                                                {t(
                                                                                        "ui.remove",
                                                                                )}
                                                                        </button>
                                                                </div>
                                                        )}
                                                </article>
                                        );
                                })
                        )}
                        {draft.rules.length > 0 && (
                                <div className="all-rules">
                                        <h4>{t("ui.allConfiguredRules")}</h4>
                                        <p>
                                                {t(
                                                        "ui.everySavedScopeRemainsDirectlyEditableIncludingOverlappingPriorityRules",
                                                )}
                                        </p>
                                        {draft.rules.map((r, i) => (
                                                <div
                                                        className="rule"
                                                        key={`${r.matchScope}-${r.deviceId}-${r.subsystemVendorId}-${r.subsystemDeviceId}-${r.bus}-${r.device}-${r.function}`}
                                                >
                                                        <label>
                                                                {t(
                                                                        "ui.matchScope",
                                                                )}
                                                                <select
                                                                        aria-label={t(
                                                                                "ui.ruleMatchScope",
                                                                                {
                                                                                        rule:
                                                                                                i +
                                                                                                1,
                                                                                },
                                                                        )}
                                                                        value={
                                                                                r.matchScope
                                                                        }
                                                                        onChange={(
                                                                                e,
                                                                        ) =>
                                                                                updateRule(
                                                                                        i,
                                                                                        {
                                                                                                matchScope: e
                                                                                                        .target
                                                                                                        .value as GpuRule["matchScope"],
                                                                                        },
                                                                                )
                                                                        }
                                                                >
                                                                        <option value="device">
                                                                                {t(
                                                                                        "ui.deviceId",
                                                                                )}
                                                                        </option>
                                                                        <option value="subsystem">
                                                                                {t(
                                                                                        "ui.subsystem",
                                                                                )}
                                                                        </option>
                                                                        <option value="location">
                                                                                {t(
                                                                                        "ui.pciLocation",
                                                                                )}
                                                                        </option>
                                                                </select>
                                                        </label>
                                                        <label>
                                                                {t(
                                                                        "ui.actionSize",
                                                                )}
                                                                <select
                                                                        aria-label={t(
                                                                                "ui.ruleActionSize",
                                                                                {
                                                                                        rule:
                                                                                                i +
                                                                                                1,
                                                                                },
                                                                        )}
                                                                        value={
                                                                                r.barSizeSelector ??
                                                                                ""
                                                                        }
                                                                        onChange={(
                                                                                e,
                                                                        ) =>
                                                                                updateRule(
                                                                                        i,
                                                                                        {
                                                                                                barSizeSelector:
                                                                                                        e
                                                                                                                .target
                                                                                                                .value ===
                                                                                                        ""
                                                                                                                ? null
                                                                                                                : Number(
                                                                                                                          e
                                                                                                                                  .target
                                                                                                                                  .value,
                                                                                                                  ),
                                                                                        },
                                                                                )
                                                                        }
                                                                >
                                                                        <option value="">
                                                                                {t(
                                                                                        "ui.noExplicitSize",
                                                                                )}
                                                                        </option>
                                                                        {pciTargetSizes.map(
                                                                                (
                                                                                        s,
                                                                                        n,
                                                                                ) => (
                                                                                        <option
                                                                                                value={
                                                                                                        n
                                                                                                }
                                                                                                key={
                                                                                                        s
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        s
                                                                                                }
                                                                                        </option>
                                                                                ),
                                                                        )}
                                                                        <option value="254">
                                                                                {t(
                                                                                        "ui.excludeGpu",
                                                                                )}
                                                                        </option>
                                                                </select>
                                                        </label>
                                                        <span className="rule-identity">
                                                                {r.matchScope ===
                                                                "location"
                                                                        ? `${r.bus.toString(16).padStart(2, "0")}:${r.device.toString(16).padStart(2, "0")}.${r.function}`
                                                                        : r.matchScope ===
                                                                            "subsystem"
                                                                          ? `DEV ${hex(r.deviceId)} / SUBSYS ${hex(r.subsystemDeviceId)}:${hex(r.subsystemVendorId)}`
                                                                          : `DEV ${hex(r.deviceId)}`}
                                                        </span>
                                                        <button
                                                                className="remove"
                                                                onClick={() =>
                                                                        patch({
                                                                                rules: draft.rules.filter(
                                                                                        (
                                                                                                _,
                                                                                                n,
                                                                                        ) =>
                                                                                                n !==
                                                                                                i,
                                                                                ),
                                                                        })
                                                                }
                                                        >
                                                                Remove rule{" "}
                                                                {i + 1}
                                                        </button>
                                                </div>
                                        ))}
                                </div>
                        )}
                </section>
        );
};
