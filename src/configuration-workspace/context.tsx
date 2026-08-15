import { createContext, useContext, type ReactNode } from "react";
import type { ConfigurationWorkspaceController } from "./use-configuration-workspace";

const ConfigurationWorkspaceContext =
        createContext<ConfigurationWorkspaceController | null>(null);

export const ConfigurationWorkspaceProvider = ({
        value,
        children,
}: {
        value: ConfigurationWorkspaceController;
        children: ReactNode;
}) => (
        <ConfigurationWorkspaceContext.Provider value={value}>
                {children}
        </ConfigurationWorkspaceContext.Provider>
);

export const useConfigurationWorkspaceController = () => {
        const value = useContext(ConfigurationWorkspaceContext);
        if (!value)
                throw new Error(
                        "Configuration workspace components require a workspace provider.",
                );
        return value;
};
