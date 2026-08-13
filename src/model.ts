import type { GpuDevice, GpuRule } from "./types";
export const formatBytes=(raw:string)=>{const n=Number(raw);return n>=1073741824?`${(n/1073741824).toFixed(n%1073741824?1:0)} GiB`:`${Math.round(n/1048576)} MiB`};
export const ruleFromGpu=(g:GpuDevice):GpuRule=>({matchScope:"location",deviceId:g.deviceId,subsystemVendorId:g.subsystemVendorId,subsystemDeviceId:g.subsystemDeviceId,bus:g.bus,device:g.device,function:g.function,barSizeSelector:g.recommendedBarSizeSelector,overrideBarSizeMask:null});
