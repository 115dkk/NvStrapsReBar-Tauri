import { describe, expect, it } from "vitest";
import { reflow } from "./licenses-dialog";

const bundledLicenses = import.meta.glob<string>("../../public/licenses/*/LICENSE", { eager: true, query: "?raw", import: "default" });

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("reflow", () => {
        it("joins wrapped lines inside a paragraph and keeps paragraphs apart", () => {
                expect(reflow("Permission is hereby granted,\nfree of charge.\n\nTHE SOFTWARE IS PROVIDED")).toBe(
                        "Permission is hereby granted, free of charge.\n\nTHE SOFTWARE IS PROVIDED",
                );
        });

        it("keeps rules and list items on their own lines", () => {
                expect(reflow("-----\nSIL OPEN FONT LICENSE\n-----\n1) Neither the Font\nSoftware nor\n2) Original")).toBe(
                        "-----\nSIL OPEN FONT LICENSE\n-----\n1) Neither the Font Software nor\n2) Original",
                );
        });

        it("keeps a capitalised heading on its own line", () => {
                expect(reflow("PREAMBLE\nThe goals of the\nlicense")).toBe("PREAMBLE\nThe goals of the license");
        });

        it("never changes the words of a bundled license", () => {
                expect(Object.keys(bundledLicenses)).toHaveLength(5);
                for (const text of Object.values(bundledLicenses)) expect(words(reflow(text))).toEqual(words(text));
        });
});
