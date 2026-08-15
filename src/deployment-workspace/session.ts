import { message, type MessageDescriptor } from "../i18n-catalog";
import type { SystemSnapshot } from "../types";
import type { DeploymentAdapter } from "./adapter";
import {
        assertPlanProjection,
        assertRecommendation,
} from "./deployment-receipts";
import { previewDeploymentAdapter } from "./preview-adapter";
import { DeploymentSessionActions } from "./session-actions";
import type { SessionActionTransaction } from "./session-action-runtime";
import type {
        DeploymentWorkspaceIntent,
        DeploymentWorkspaceSession,
        DeploymentWorkspaceState,
        DeploymentWorkspaceView,
} from "./session-contract";
import { projectDeploymentWorkspace } from "./session-projection";
import {
        createInitialDeploymentState,
        reduceLocalDeploymentIntent,
        resetProfileProjection,
} from "./session-state";
import { tauriDeploymentAdapter } from "./tauri-adapter";

export type {
        DeploymentNextAction,
        DeploymentWorkspaceActivity,
        DeploymentWorkspaceIntent,
        DeploymentWorkspaceSession,
        DeploymentWorkspaceView,
} from "./session-contract";

const isTauri = () =>
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const errorText = (error: unknown) =>
        (error as { message?: string }).message || String(error);

const deploymentError = (error: unknown): MessageDescriptor =>
        message("ui.deploymentOperationFailed", { detail: errorText(error) });

/**
 * Owns the client projection lifecycle: one in-flight operation, generation-
 * bound replies, publication, and disposal. Domain intent protocols live in
 * DeploymentSessionActions and authoritative transitions remain in Rust.
 */
class Session implements DeploymentWorkspaceSession {
        private listeners = new Set<() => void>();
        private disposed = false;
        private generation = 0;
        private inflight: Promise<void> | null = null;
        private cachedView: DeploymentWorkspaceView | null = null;
        private state: DeploymentWorkspaceState;
        private actions: DeploymentSessionActions;

        constructor(
                snapshot: SystemSnapshot,
                private adapter: DeploymentAdapter,
        ) {
                this.state = createInitialDeploymentState(snapshot);
                this.actions = new DeploymentSessionActions({
                        adapter,
                        state: () => this.state,
                        view: this.view,
                        patch: (value) => this.patch(value),
                        run: (action, work) => this.run(action, work),
                        selectProfile: (profileId) =>
                                this.selectProfile(profileId),
                        loadRecommendation: () => this.loadRecommendation(),
                });
                void this.initialize();
        }

        view = (): DeploymentWorkspaceView => {
                if (!this.cachedView)
                        this.cachedView = projectDeploymentWorkspace(
                                this.state,
                        );
                return this.cachedView;
        };

        dispatch = async (intent: DeploymentWorkspaceIntent): Promise<void> => {
                if (this.disposed) return;
                const localPatch = reduceLocalDeploymentIntent(
                        this.state,
                        intent,
                );
                if (localPatch) {
                        this.patch(localPatch);
                        return;
                }
                await this.actions.dispatch(intent);
        };

        subscribe = (listener: () => void) => {
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
        };

        dispose = () => {
                this.disposed = true;
                this.generation += 1;
                this.listeners.clear();
        };

        private emit() {
                if (!this.disposed)
                        this.listeners.forEach((listener) => listener());
        }

        private patch(value: Partial<DeploymentWorkspaceState>) {
                Object.assign(this.state, value);
                this.cachedView = null;
                this.emit();
        }

        private async initialize() {
                const generation = ++this.generation;
                try {
                        const [profiles, installation] = await Promise.all([
                                this.adapter.listMachineProfiles(),
                                this.adapter.getNvidiaProfileInspectorInstallation(),
                        ]);
                        if (this.disposed || generation !== this.generation)
                                return;
                        this.patch({
                                profiles,
                                installation,
                                selectedProfileId: profiles[0]?.profileId ?? "",
                        });
                        if (profiles[0])
                                await this.loadPlan(
                                        profiles[0].profileId,
                                        generation,
                                );
                } catch (error) {
                        if (generation === this.generation)
                                this.patch({
                                        activity: {
                                                tone: "error",
                                                message: deploymentError(error),
                                        },
                                });
                }
        }

        private async selectProfile(profileId: string) {
                this.generation += 1;
                this.inflight = null;
                this.patch(resetProfileProjection(profileId));
                await this.loadPlan(profileId, this.generation);
        }

        private async loadPlan(
                profileId: string,
                generation = ++this.generation,
        ) {
                if (!profileId) {
                        this.patch({ plan: null });
                        return;
                }
                try {
                        const plan =
                                await this.adapter.getDeploymentPlan(profileId);
                        if (
                                this.disposed ||
                                generation !== this.generation ||
                                this.state.selectedProfileId !== profileId
                        )
                                return;
                        const profile = this.state.profiles.find(
                                (candidate) =>
                                        candidate.profileId === profileId,
                        );
                        if (!profile)
                                throw new Error(
                                        "The selected deployment profile is unavailable.",
                                );
                        assertPlanProjection(profile, plan);
                        this.patch({ plan });
                        void this.loadRecommendation();
                } catch (error) {
                        if (generation === this.generation)
                                this.patch({
                                        activity: {
                                                tone: "error",
                                                message: deploymentError(error),
                                        },
                                });
                }
        }

        private run(
                action: string,
                work: (transaction: SessionActionTransaction) => Promise<void>,
        ): Promise<void> {
                if (this.inflight) return this.inflight;
                const generation = this.generation;
                this.patch({ busyAction: action, activity: null });
                const current = () =>
                        !this.disposed && generation === this.generation;
                const transaction: SessionActionTransaction = {
                        patch: (value) => {
                                if (current()) this.patch(value);
                        },
                        success: (successMessage) => {
                                if (current()) this.success(successMessage);
                        },
                        current,
                };
                const promise = work(transaction)
                        .catch((error) => {
                                if (
                                        !this.disposed &&
                                        generation === this.generation
                                )
                                        this.patch({
                                                activity: {
                                                        tone: "error",
                                                        message: deploymentError(
                                                                error,
                                                        ),
                                                },
                                        });
                        })
                        .finally(() => {
                                if (this.inflight === promise) {
                                        this.inflight = null;
                                        this.patch({ busyAction: "" });
                                }
                        });
                this.inflight = promise;
                return promise;
        }

        private success(successMessage: MessageDescriptor) {
                this.patch({
                        activity: {
                                tone: "success",
                                message: successMessage,
                        },
                });
        }

        private async loadRecommendation() {
                const plan = this.state.plan;
                if (
                        plan?.steps.find((step) => step.state === "ready")
                                ?.id !== "writeNvstrapsConfiguration"
                ) {
                        this.patch({
                                recommendationStatus: "idle",
                                configRecommendation: null,
                                recommendationError: null,
                                guardedConfigConfirmed: false,
                        });
                        return;
                }
                const generation = this.generation;
                this.patch({
                        recommendationStatus: "pending",
                        configRecommendation: null,
                        recommendationError: null,
                        guardedConfigConfirmed: false,
                });
                try {
                        const value = assertRecommendation(
                                await this.adapter.getRecommendedDeploymentConfig(
                                        plan.profileId,
                                ),
                        );
                        if (
                                generation !== this.generation ||
                                this.state.plan?.profileId !== plan.profileId ||
                                this.state.plan.revision !== plan.revision
                        )
                                return;
                        this.patch({
                                configRecommendation: {
                                        profileId: plan.profileId,
                                        planRevision: plan.revision,
                                        value,
                                },
                                recommendationStatus: "ready",
                        });
                } catch (error) {
                        if (generation === this.generation) {
                                const errorMessage = deploymentError(error);
                                this.patch({
                                        recommendationStatus: "error",
                                        recommendationError: errorMessage,
                                        activity: {
                                                tone: "error",
                                                message: errorMessage,
                                        },
                                });
                        }
                }
        }
}

export const createDeploymentWorkspaceSession = (
        snapshot: SystemSnapshot,
        adapter: DeploymentAdapter = isTauri()
                ? tauriDeploymentAdapter
                : previewDeploymentAdapter,
): DeploymentWorkspaceSession => new Session(snapshot, adapter);
