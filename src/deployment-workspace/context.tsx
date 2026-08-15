import { createContext, useContext, type ReactNode } from "react";
import type { DeploymentWorkspaceController } from "./use-deployment-workspace";

const DeploymentWorkspaceContext =
        createContext<DeploymentWorkspaceController | null>(null);

export const DeploymentWorkspaceProvider = ({
        value,
        children,
}: {
        value: DeploymentWorkspaceController;
        children: ReactNode;
}) => (
        <DeploymentWorkspaceContext.Provider value={value}>
                {children}
        </DeploymentWorkspaceContext.Provider>
);

export const useDeploymentWorkspaceController = () => {
        const value = useContext(DeploymentWorkspaceContext);
        if (!value)
                throw new Error(
                        "Deployment workspace components require a workspace provider.",
                );
        return value;
};
