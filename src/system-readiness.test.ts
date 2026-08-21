import { describe, expect, it } from "vitest";
import { above4gDecodingConfirmed } from "./system-readiness";
import type { SystemSnapshot } from "./types";

const snapshot = (tops: string[]): SystemSnapshot =>
        ({
                devices: tops.map((bar0Top) => ({ bar0Top })),
        }) as unknown as SystemSnapshot;

describe("above 4G decoding proof", () => {
        it("confirms the decode window from a BAR observed above 4 GiB", () => {
                expect(above4gDecodingConfirmed(snapshot(["4294967296"]))).toBe(
                        true,
                );
                expect(
                        above4gDecodingConfirmed(
                                snapshot(["4043309055", "10737418239"]),
                        ),
                ).toBe(true);
        });

        it("stays unconfirmed when every BAR fits below 4 GiB", () => {
                expect(above4gDecodingConfirmed(snapshot(["4294967295"]))).toBe(
                        false,
                );
                expect(above4gDecodingConfirmed(snapshot([]))).toBe(false);
        });

        it("ignores malformed addresses instead of throwing", () => {
                expect(
                        above4gDecodingConfirmed(snapshot(["", "not-a-number"])),
                ).toBe(false);
        });
});
