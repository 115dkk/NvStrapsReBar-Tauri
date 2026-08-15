import { translateMessage, useI18n } from "../i18n";
import { stepKindIds, stepStateIds, stepTitleIds } from "./messages";
import { useDeploymentWorkspaceController } from "./context";
import { JourneyHeading, shortHash } from "./presentation";
import { WorkflowAction } from "./workflow-action";
export const ArtifactJourney = () => {
        const { locale, t, n } = useI18n();
        const { view, commands } = useDeploymentWorkspaceController();
        const {
                profiles,
                selectedProfileId,
                plan,
                activeStep,
                activeStepTitleId,
                workflowReceipt,
                barEvidence,
                installation,
                backup,
                launch,
                busyAction,
                preparation,
                destination,
                packageReceipt,
        } = view;
        const {
                setSelectedProfileId,
                compare,
                setDestination,
                chooseDestination,
                exportPackage,
        } = commands;
        return (
                                <section className="journey-panel" aria-labelledby="artifact-title">
                                        <JourneyHeading
                                                number="02"
                                                title={t("ui.checkExport")}
                                                id="artifact-title"
                                                copy={t("ui.compareTheCurrentHardwareAndSourceImagePrepareTheRustFirmwareArtifactAndExportThePackage")}
                                        />
                                        <label className="field profile-select">
                                                <span>{t("ui.machineProfile")}</span>
                                                <select
                                                        value={selectedProfileId}
                                                        disabled={Boolean(busyAction)}
                                                        onChange={(event) =>
                                                                setSelectedProfileId(event.target.value)
                                                        }
                                                >
                                                        {!profiles.length && (
                                                                <option value="">{t("ui.noStoredProfiles")}</option>
                                                        )}
                                                        {profiles.map((profile) => (
                                                                <option
                                                                        key={profile.profileId}
                                                                        value={profile.profileId}
                                                                >
                                                                        {profile.displayName}
                                                                </option>
                                                        ))}
                                                </select>
                                        </label>
                                        {plan && (
                                                <div className="active-workflow" aria-live="polite">
                                                        <div className="active-workflow-head">
                                                                <div>
                                                                        <span className="step">{t("ui.activeStep")}</span>
                                                                        <h4>
                                                                                {activeStepTitleId ? t(activeStepTitleId) : t("ui.deploymentComplete")}
                                                                        </h4>
                                                                        <p>
                                                                                {activeStep
                                                                                        ? t("ui.completeTheActiveStepToContinue")
                                                                                        : t("ui.noRemainingSteps")}
                                                                        </p>
                                                                </div>
                                                                <strong>
                                                                        {plan.steps.filter((step) => step.state === "completed").length}/{plan.steps.length}
                                                                </strong>
                                                        </div>
                                                        <div className="active-workflow-action">
                                                                <WorkflowAction />
                                                        </div>
                                                        {workflowReceipt && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{translateMessage(locale, workflowReceipt.title)}</strong>
                                                                        <span>{translateMessage(locale, workflowReceipt.detail)}</span>
                                                                </div>
                                                        )}
                                                        {barEvidence && (
                                                                <div className="workflow-receipt" role="status">
                                                                        <strong>{barEvidence.gpus[0]?.productName}</strong>
                                                                        <span>
                                                                                BAR1 {barEvidence.gpus[0]?.bar1TotalBytes ? `${Math.round(Number(barEvidence.gpus[0].bar1TotalBytes) / 1073741824)} GiB` : "unavailable"} · Driver {barEvidence.driverVersion}
                                                                        </span>
                                                                </div>
                                                        )}
                                                        {installation && activeStep?.id === "configureNvidiaApplications" && (
                                                                <div className="workflow-receipt">
                                                                        <strong>
                                                                                {t("ui.profileInspectorVersionInstalled", {
                                                                                        version: installation.manifest.version,
                                                                                })}
                                                                        </strong>
                                                                        <span>{t("ui.nextApplyTheNvidiaPolicyThenRecordTheResult")}</span>
                                                                </div>
                                                        )}
                                                        {backup && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line mono-wrap">
                                                                        {t("ui.profileBackup")}: {backup.backupPath}
                                                                </small>
                                                        )}
                                                        {launch && activeStep?.id === "configureNvidiaApplications" && (
                                                                <small className="verified-line">
                                                                        {t("ui.editorProcessLaunched", {
                                                                                processId: launch.processId,
                                                                        })}
                                                                </small>
                                                        )}
                                                </div>
                                        )}
                                        {plan && (
                                                <ol className="plan-list" aria-label={t("ui.deploymentPlan")}>
                                                        {plan.steps.map((step) => (
                                                                <li
                                                                        key={step.id}
                                                                        className={`plan-step ${step.state}`}
                                                                >
                                                                        <i aria-hidden="true" />
                                                                        <div>
                                                                                <strong>{t(stepTitleIds[step.id])}</strong>
                                                                                <span>
                                                                                        {t(stepKindIds[step.kind])}
                                                                                </span>
                                                                        </div>
                                                                        <b>{t(stepStateIds[step.state])}</b>
                                                                </li>
                                                        ))}
                                                </ol>
                                        )}
                                        <div className="action-row">
                                                <button
                                                        onClick={compare}
                                                        disabled={Boolean(busyAction) || !selectedProfileId}
                                                >{t("ui.checkCurrentHardwareAndSourceImage")}</button>
                                        </div>
                                        {preparation?.patchedFirmware && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("ui.preparedFirmwareArtifact")}</strong>
                                                        <span>
                                                                {n(preparation.patchedFirmware.byteLength)} {t("ui.bytes")} · SHA-256 {shortHash(preparation.patchedFirmware.sha256)}
                                                        </span>
                                                        <small>{t("ui.nextExportThisArtifactForTheVendorTool")}</small>
                                                </div>
                                        )}
                                        <div className="path-control export-control">
                                                <input
                                                        aria-label={t("ui.deploymentPackageDestination")}
                                                        value={destination}
                                                        placeholder={t("ui.chooseAnEmptyDestinationFolder")}
                                                        onChange={(event) =>
                                                                setDestination(event.target.value)
                                                        }
                                                />
                                                <button
                                                        className="quiet"
                                                        onClick={chooseDestination}
                                                        disabled={Boolean(busyAction)}
                                                >{t("ui.chooseFolder")}</button>
                                                <button
                                                        className="primary"
                                                        onClick={exportPackage}
                                                        disabled={
                                                                Boolean(busyAction) ||
                                                                plan?.steps.find((step) => step.id === "verifyPatchedArtifact")?.state !== "completed" ||
                                                                !destination
                                                        }
                                                >{t("ui.exportPackage")}</button>
                                        </div>
                                        {packageReceipt && (
                                                <div className="artifact-receipt" role="status">
                                                        <strong>{t("ui.packageExportedManualHandoffNext")}</strong>
                                                        <span className="mono-wrap">{packageReceipt.packagePath}</span>
                                                        <small>
                                                                {packageReceipt.manifest.files.length} files · manifest SHA-256 {shortHash(packageReceipt.manifestSha256)}
                                                        </small>
                                                </div>
                                        )}
                                </section>
        );
};
