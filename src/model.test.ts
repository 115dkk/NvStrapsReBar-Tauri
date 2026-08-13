import { describe, expect, it } from "vitest";
import { formatBytes, ruleFromGpu } from "./model";
import type { GpuDevice } from "./types";
const gpu:GpuDevice={id:"pci-01-00-0",name:"GPU",vendorId:0x10de,deviceId:0x1e87,subsystemVendorId:0x1043,subsystemDeviceId:0x8673,bus:1,device:0,function:0,bar0Base:"0x0",bar0Top:"0x0",currentBarSize:"268435456",dedicatedVideoMemory:"8589934592",isTuring:true,recommendedBarSizeSelector:5,effectiveBarSizeSelector:null};
describe("frontend draft model",()=>{
 it("formats backend byte strings for expert display",()=>{expect(formatBytes("8589934592")).toBe("8 GiB");expect(formatBytes("268435456")).toBe("256 MiB")});
 it("creates a location-scoped rule with all backend identifiers",()=>{expect(ruleFromGpu(gpu)).toEqual({matchScope:"location",deviceId:0x1e87,subsystemVendorId:0x1043,subsystemDeviceId:0x8673,bus:1,device:0,function:0,barSizeSelector:5,overrideBarSizeMask:null})});
});
