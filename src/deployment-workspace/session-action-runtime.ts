import type { MessageDescriptor } from "../i18n-catalog";
import type { DeploymentAdapter } from "./adapter";
import type {
        DeploymentWorkspaceState,
        DeploymentWorkspaceView,
} from "./session-contract";

export interface SessionActionTransaction {
        patch(value: Partial<DeploymentWorkspaceState>): void;
        success(message: MessageDescriptor): void;
        current(): boolean;
}

export interface DeploymentSessionRuntime {
        adapter: DeploymentAdapter;
        state(): DeploymentWorkspaceState;
        view(): DeploymentWorkspaceView;
        patch(value: Partial<DeploymentWorkspaceState>): void;
        run(
                action: string,
                work: (transaction: SessionActionTransaction) => Promise<void>,
        ): Promise<void>;
        selectProfile(profileId: string): Promise<void>;
        loadRecommendation(): Promise<void>;
}
