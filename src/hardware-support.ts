import type { SystemSnapshot } from "./types";
import type { StaticMessageId } from "./i18n-catalog";

export const MSI_PRO_Z690_A_DDR4_CATALOG_ID =
        "msi-pro-z690-a-ddr4-ms-7d25";

export const usesMsiProZ690Route = (snapshot: SystemSnapshot) =>
        snapshot.hardwareSupport.motherboardNativeResizableBar.catalogId ===
        MSI_PRO_Z690_A_DDR4_CATALOG_ID;

export const setupUtilityName = (boardManufacturer: string | undefined): string | null => {
        const maker = boardManufacturer?.trim().toLowerCase() ?? "";
        if (maker.includes("micro-star") || maker.startsWith("msi")) return "M-FLASH";
        if (maker.includes("asustek") || maker.includes("asus")) return "EZ Flash";
        if (maker.includes("gigabyte")) return "Q-Flash";
        if (maker.includes("asrock")) return "Instant Flash";
        return null;
};

export type MotherboardSupportPresentation = {
        statusId: StaticMessageId;
        symbol: "O" | "X" | "?";
        tone: "supported" | "unsupported" | "unknown";
        boardProduct: string | null;
};

export function presentMotherboardSupport(
        snapshot: SystemSnapshot,
): MotherboardSupportPresentation {
        const finding = snapshot.hardwareSupport.motherboardNativeResizableBar;
        const boardProduct = snapshot.machineIdentity?.boardProduct ?? null;
        if (finding.state === "supported")
                return {
                        statusId: "ui.supported",
                        symbol: "O",
                        tone: "supported",
                        boardProduct,
                };
        if (finding.state === "unsupported")
                return {
                        statusId: "ui.unsupported",
                        symbol: "X",
                        tone: "unsupported",
                        boardProduct,
                };
        if (finding.reasonCode === "motherboardNotInCatalog")
                return {
                        statusId: "ui.notInCurrentSupportList",
                        symbol: "?",
                        tone: "unknown",
                        boardProduct,
                };
        return {
                statusId: "ui.motherboardIdentityUnavailable",
                symbol: "?",
                tone: "unknown",
                boardProduct: null,
        };
}
