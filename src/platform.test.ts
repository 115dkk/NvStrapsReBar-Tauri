import { afterEach, describe, expect, it, vi } from "vitest";
import { previewConfigureBridge } from "./bridge";
import { hostOsOf } from "./platform";

afterEach(() => vi.unstubAllGlobals());

describe("host OS", () => {
        it("reads Linux from the snapshot and keeps Windows for everything else", () => {
                expect(hostOsOf("linux")).toBe("linux");
                expect(hostOsOf("windows")).toBe("windows");
                expect(hostOsOf(undefined)).toBe("windows");
                expect(hostOsOf("")).toBe("windows");
                expect(hostOsOf("macos")).toBe("windows");
                expect(hostOsOf("Linux")).toBe("windows");
        });

        it("lets the browser preview report Linux with ?os=linux", async () => {
                expect((await previewConfigureBridge.snapshot()).platform.operatingSystem).toBe("windows");
                vi.stubGlobal("location", { search: "?os=linux" });
                expect((await previewConfigureBridge.snapshot()).platform.operatingSystem).toBe("linux");
                expect((await previewConfigureBridge.refresh()).platform.operatingSystem).toBe("linux");
                vi.stubGlobal("location", { search: "?os=windows" });
                expect((await previewConfigureBridge.snapshot()).platform.operatingSystem).toBe("windows");
        });
});
