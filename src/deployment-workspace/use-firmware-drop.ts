import { useEffect, useEffectEvent, useState } from "react";
import type { FileDropEvent } from "./adapter";
import { useDeploymentWorkspaceController } from "./context";

export const useFirmwareDrop = (active: boolean): { over: boolean } => {
        const { commands, getView, watchFileDrops } = useDeploymentWorkspaceController();
        const [over, setOver] = useState(false);
        const onDropEvent = useEffectEvent((event: FileDropEvent) => {
                setOver(event.kind === "over");
                if (event.kind !== "drop" || event.paths.length !== 1 || getView().busyAction)
                        return;
                commands.setFirmwarePath(event.paths[0]!);
                commands.inspectManualPath();
        });

        useEffect(() => {
                setOver(false);
                if (!active) return;
                let stopped = false;
                const unsubscribe = watchFileDrops((event) => {
                        if (!stopped) onDropEvent(event);
                });
                return () => {
                        stopped = true;
                        unsubscribe();
                };
        }, [active, watchFileDrops]);

        return { over: active && over };
};
