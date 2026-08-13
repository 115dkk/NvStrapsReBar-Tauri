use serde::Serialize;

use nvstraps_core::registry::{NVIDIA_VENDOR_ID, automatic_bar_size, is_turing};

use crate::error::{BackendError, BackendResult};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PciBridge {
    pub vendor_id: u16,
    pub device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub id: String,
    pub name: String,
    pub vendor_id: u16,
    pub device_id: u16,
    pub subsystem_vendor_id: u16,
    pub subsystem_device_id: u16,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
    pub bridge: PciBridge,
    #[serde(serialize_with = "serialize_hex_u64")]
    pub bar0_base: u64,
    #[serde(serialize_with = "serialize_hex_u64")]
    pub bar0_top: u64,
    #[serde(serialize_with = "serialize_decimal_u64")]
    pub current_bar_size: u64,
    #[serde(serialize_with = "serialize_decimal_u64")]
    pub dedicated_video_memory: u64,
    pub is_turing: bool,
    pub recommended_bar_size_selector: Option<u8>,
    pub effective_bar_size_selector: Option<u8>,
}

pub fn enumerate_gpus() -> BackendResult<Vec<GpuDevice>> {
    #[cfg(windows)]
    {
        windows_impl::enumerate_gpus()
    }

    #[cfg(not(windows))]
    {
        Err(BackendError::UnsupportedPlatform)
    }
}

fn serialize_hex_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&format!("0x{value:016X}"))
}

fn serialize_decimal_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}

#[cfg(windows)]
mod windows_impl {
    use std::{ffi::c_void, mem::size_of, ptr};

    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    use windows_sys::{
        Win32::{
            Devices::{
                DeviceAndDriverInstallation::{
                    ALLOC_LOG_CONF, CM_Free_Log_Conf_Handle, CM_Free_Res_Des_Handle,
                    CM_Get_First_Log_Conf, CM_Get_Next_Res_Des, CM_Get_Res_Des_Data,
                    CR_NO_MORE_RES_DES, DIGCF_PRESENT, HDEVINFO, MEM_LARGE_RANGE,
                    MEM_LARGE_RESOURCE, MEM_RANGE, MEM_RESOURCE, ResType_All, ResType_IO,
                    ResType_Mem, ResType_MemLarge, ResType_None, SP_DEVINFO_DATA,
                    SetupDiCreateDeviceInfoList, SetupDiDestroyDeviceInfoList,
                    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDevicePropertyW,
                    SetupDiOpenDeviceInfoW, fMD_RAM, fMD_ReadAllowed, mMD_MemoryType, mMD_Readable,
                },
                Properties::{DEVPROP_TYPE_STRING, DEVPROP_TYPE_UINT32, DEVPROPTYPE},
            },
            Foundation::{ERROR_NO_MORE_ITEMS, GetLastError, HWND},
        },
        core::GUID,
    };

    use super::*;

    const DISPLAY_ADAPTER_CLASS: GUID = GUID {
        data1: 0x4D36_E968,
        data2: 0xE325,
        data3: 0x11CE,
        data4: [0xBF, 0xC1, 0x08, 0x00, 0x2B, 0xE1, 0x03, 0x18],
    };

    struct DeviceInfoSet(HDEVINFO);

    impl DeviceInfoSet {
        fn new(handle: HDEVINFO, operation: &'static str) -> BackendResult<Self> {
            if handle == -1_isize {
                Err(BackendError::windows(operation))
            } else {
                Ok(Self(handle))
            }
        }
    }

    impl Drop for DeviceInfoSet {
        fn drop(&mut self) {
            // SAFETY: the set handle is valid and owned by this guard.
            unsafe { SetupDiDestroyDeviceInfoList(self.0) };
        }
    }

    pub fn enumerate_gpus() -> BackendResult<Vec<GpuDevice>> {
        let pci = wide("PCI");
        // SAFETY: pointers remain valid for the duration of the calls; null HWND is allowed.
        let adapters = DeviceInfoSet::new(
            unsafe {
                SetupDiGetClassDevsW(
                    &DISPLAY_ADAPTER_CLASS,
                    pci.as_ptr(),
                    ptr::null_mut::<c_void>() as HWND,
                    DIGCF_PRESENT,
                )
            },
            "SetupDiGetClassDevsW",
        )?;
        let bridges = DeviceInfoSet::new(
            // SAFETY: a null class GUID and parent window are allowed.
            unsafe { SetupDiCreateDeviceInfoList(ptr::null(), ptr::null_mut()) },
            "SetupDiCreateDeviceInfoList",
        )?;

        let memory_by_adapter = dedicated_memory_by_adapter()?;
        let mut result = Vec::new();
        let mut index = 0;
        loop {
            let mut info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            // SAFETY: the set and output struct are valid.
            if unsafe { SetupDiEnumDeviceInfo(adapters.0, index, &mut info) } == 0 {
                // SAFETY: GetLastError has no preconditions.
                let error = unsafe { GetLastError() };
                if error == ERROR_NO_MORE_ITEMS {
                    break;
                }
                return Err(BackendError::Windows {
                    operation: "SetupDiEnumDeviceInfo",
                    code: error,
                });
            }
            index += 1;

            let instance_id = property_string(
                adapters.0,
                &info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_InstanceId,
            )?;
            let ids = parse_pci_ids(&instance_id).ok_or_else(|| {
                BackendError::DeviceInventory(format!(
                    "unexpected display adapter instance ID: {instance_id}"
                ))
            })?;
            if ids.vendor_id != NVIDIA_VENDOR_ID {
                continue;
            }

            let name = property_string(
                adapters.0,
                &info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_NAME,
            )?;
            let bus = property_u32(
                adapters.0,
                &info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_BusNumber,
            )?;
            let address = property_u32(
                adapters.0,
                &info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_Address,
            )?;
            let (bus, device, function) = validate_location(bus, address, "display adapter")?;

            let parent_id = property_string(
                adapters.0,
                &info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_Parent,
            )?;
            let parent_ids = parse_pci_ids(&parent_id).ok_or_else(|| {
                BackendError::DeviceInventory(format!(
                    "unexpected parent bridge instance ID: {parent_id}"
                ))
            })?;
            let parent_wide = wide(&parent_id);
            let mut parent_info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            // SAFETY: the list and null-terminated instance string are valid.
            if unsafe {
                SetupDiOpenDeviceInfoW(
                    bridges.0,
                    parent_wide.as_ptr(),
                    ptr::null_mut(),
                    0,
                    &mut parent_info,
                )
            } == 0
            {
                return Err(BackendError::windows("SetupDiOpenDeviceInfoW"));
            }
            let bridge_bus = property_u32(
                bridges.0,
                &parent_info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_BusNumber,
            )?;
            let bridge_address = property_u32(
                bridges.0,
                &parent_info,
                &windows_sys::Win32::Devices::Properties::DEVPKEY_Device_Address,
            )?;
            let (bridge_bus, bridge_device, bridge_function) =
                validate_location(bridge_bus, bridge_address, "PCI bridge")?;

            let resources = device_memory_resources(info.DevInst).unwrap_or_default();
            let dedicated_video_memory = memory_by_adapter
                .iter()
                .find(|entry| {
                    entry.vendor_id == ids.vendor_id
                        && entry.device_id == ids.device_id
                        && entry.subsystem_id
                            == (u32::from(ids.subsystem_device_id) << 16
                                | u32::from(ids.subsystem_vendor_id))
                })
                .map_or(0, |entry| entry.dedicated_video_memory);

            result.push(GpuDevice {
                id: format!("pci-{bus:02x}-{device:02x}-{function}"),
                name,
                vendor_id: ids.vendor_id,
                device_id: ids.device_id,
                subsystem_vendor_id: ids.subsystem_vendor_id,
                subsystem_device_id: ids.subsystem_device_id,
                bus,
                device,
                function,
                bridge: PciBridge {
                    vendor_id: parent_ids.vendor_id,
                    device_id: parent_ids.device_id,
                    bus: bridge_bus,
                    device: bridge_device,
                    function: bridge_function,
                },
                bar0_base: resources.bar0_base,
                bar0_top: resources.bar0_top,
                current_bar_size: resources.max_size,
                dedicated_video_memory,
                is_turing: is_turing(ids.device_id),
                recommended_bar_size_selector: automatic_bar_size(ids.device_id),
                effective_bar_size_selector: None,
            });
        }
        Ok(result)
    }

    #[derive(Clone, Copy)]
    struct PciIds {
        vendor_id: u16,
        device_id: u16,
        subsystem_vendor_id: u16,
        subsystem_device_id: u16,
    }

    fn parse_pci_ids(value: &str) -> Option<PciIds> {
        let uppercase = value.to_ascii_uppercase();
        let vendor_id = parse_hex_field(&uppercase, "VEN_")?;
        let device_id = parse_hex_field(&uppercase, "DEV_")?;
        let subsys = uppercase
            .split("SUBSYS_")
            .nth(1)?
            .chars()
            .take(8)
            .collect::<String>();
        if subsys.len() != 8 {
            return None;
        }
        Some(PciIds {
            vendor_id,
            device_id,
            subsystem_device_id: u16::from_str_radix(&subsys[..4], 16).ok()?,
            subsystem_vendor_id: u16::from_str_radix(&subsys[4..], 16).ok()?,
        })
    }

    fn parse_hex_field(value: &str, marker: &str) -> Option<u16> {
        let digits = value
            .split(marker)
            .nth(1)?
            .chars()
            .take(4)
            .collect::<String>();
        u16::from_str_radix(&digits, 16).ok()
    }

    fn validate_location(bus: u32, address: u32, label: &str) -> BackendResult<(u8, u8, u8)> {
        if bus > u32::from(u8::MAX) || address & 0xFFE0_FFF8 != 0 {
            return Err(BackendError::DeviceInventory(format!(
                "invalid PCI location for {label}: bus {bus}, address 0x{address:08X}"
            )));
        }
        Ok((
            bus as u8,
            ((address >> 16) & 0xFF) as u8,
            (address & 0xFF) as u8,
        ))
    }

    fn property_string(
        set: HDEVINFO,
        info: &SP_DEVINFO_DATA,
        key: &windows_sys::Win32::Foundation::DEVPROPKEY,
    ) -> BackendResult<String> {
        let (kind, bytes) = property(set, info, key)?;
        if kind != DEVPROP_TYPE_STRING || bytes.len() % 2 != 0 {
            return Err(BackendError::DeviceInventory(
                "unexpected string device property format".into(),
            ));
        }
        let mut words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        while words.last() == Some(&0) {
            words.pop();
        }
        String::from_utf16(&words).map_err(|error| BackendError::DeviceInventory(error.to_string()))
    }

    fn property_u32(
        set: HDEVINFO,
        info: &SP_DEVINFO_DATA,
        key: &windows_sys::Win32::Foundation::DEVPROPKEY,
    ) -> BackendResult<u32> {
        let (kind, bytes) = property(set, info, key)?;
        if kind != DEVPROP_TYPE_UINT32 || bytes.len() != 4 {
            return Err(BackendError::DeviceInventory(
                "unexpected integer device property format".into(),
            ));
        }
        Ok(u32::from_le_bytes(
            bytes.try_into().expect("length checked"),
        ))
    }

    fn property(
        set: HDEVINFO,
        info: &SP_DEVINFO_DATA,
        key: &windows_sys::Win32::Foundation::DEVPROPKEY,
    ) -> BackendResult<(DEVPROPTYPE, Vec<u8>)> {
        let mut kind = 0;
        let mut required = 0;
        let mut buffer = vec![0_u8; 4096];
        // SAFETY: all input and output pointers refer to valid storage.
        if unsafe {
            SetupDiGetDevicePropertyW(
                set,
                info,
                key,
                &mut kind,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut required,
                0,
            )
        } == 0
        {
            return Err(BackendError::windows("SetupDiGetDevicePropertyW"));
        }
        buffer.truncate(required as usize);
        Ok((kind, buffer))
    }

    #[derive(Default)]
    struct MemoryResources {
        max_size: u64,
        bar0_base: u64,
        bar0_top: u64,
    }

    #[allow(non_upper_case_globals)]
    fn device_memory_resources(device_instance: u32) -> BackendResult<MemoryResources> {
        let mut logical_configuration = 0_usize;
        // SAFETY: output pointer is valid.
        let status = unsafe {
            CM_Get_First_Log_Conf(&mut logical_configuration, device_instance, ALLOC_LOG_CONF)
        };
        if status != 0 {
            return Err(BackendError::DeviceInventory(format!(
                "CM_Get_First_Log_Conf failed with CONFIGRET {status}"
            )));
        }
        let mut resources = MemoryResources::default();
        let mut first_resource = true;
        let mut descriptor = 0_usize;
        let mut resource_type = ResType_None;
        // SAFETY: all handles and output pointers are valid.
        let mut status = unsafe {
            CM_Get_Next_Res_Des(
                &mut descriptor,
                logical_configuration,
                ResType_All,
                &mut resource_type,
                0,
            )
        };
        while status == 0 {
            match resource_type {
                ResType_Mem => {
                    let mut memory = MEM_RESOURCE::default();
                    // SAFETY: packed field is written unaligned and buffer is valid for the API.
                    unsafe {
                        ptr::addr_of_mut!(memory.MEM_Header.MD_Type).write_unaligned(size_of::<
                            MEM_RANGE,
                        >(
                        )
                            as u32)
                    };
                    // SAFETY: descriptor and destination storage are valid.
                    let read_status = unsafe {
                        CM_Get_Res_Des_Data(
                            descriptor,
                            &mut memory as *mut _ as *mut c_void,
                            size_of::<MEM_RESOURCE>() as u32,
                            0,
                        )
                    };
                    if read_status == 0 {
                        // SAFETY: reads from packed fields are explicitly unaligned.
                        let (base, top, flags) = unsafe {
                            (
                                ptr::addr_of!(memory.MEM_Header.MD_Alloc_Base).read_unaligned(),
                                ptr::addr_of!(memory.MEM_Header.MD_Alloc_End).read_unaligned(),
                                ptr::addr_of!(memory.MEM_Header.MD_Flags).read_unaligned(),
                            )
                        };
                        process_memory_range(&mut resources, &mut first_resource, base, top, flags);
                    }
                }
                ResType_MemLarge => {
                    let mut memory = MEM_LARGE_RESOURCE::default();
                    // SAFETY: packed field is written unaligned and buffer is valid for the API.
                    unsafe {
                        ptr::addr_of_mut!(memory.MEM_LARGE_Header.MLD_Type)
                            .write_unaligned(size_of::<MEM_LARGE_RANGE>() as u32)
                    };
                    // SAFETY: descriptor and destination storage are valid.
                    let read_status = unsafe {
                        CM_Get_Res_Des_Data(
                            descriptor,
                            &mut memory as *mut _ as *mut c_void,
                            size_of::<MEM_LARGE_RESOURCE>() as u32,
                            0,
                        )
                    };
                    if read_status == 0 {
                        // SAFETY: reads from packed fields are explicitly unaligned.
                        let (base, top, flags) = unsafe {
                            (
                                ptr::addr_of!(memory.MEM_LARGE_Header.MLD_Alloc_Base)
                                    .read_unaligned(),
                                ptr::addr_of!(memory.MEM_LARGE_Header.MLD_Alloc_End)
                                    .read_unaligned(),
                                ptr::addr_of!(memory.MEM_LARGE_Header.MLD_Flags).read_unaligned(),
                            )
                        };
                        process_memory_range(&mut resources, &mut first_resource, base, top, flags);
                    }
                }
                ResType_IO if first_resource => first_resource = false,
                _ => {}
            }

            let old = descriptor;
            descriptor = 0;
            resource_type = ResType_None;
            // SAFETY: current descriptor is valid; output pointers are valid.
            status = unsafe {
                CM_Get_Next_Res_Des(&mut descriptor, old, ResType_All, &mut resource_type, 0)
            };
            // SAFETY: old descriptor is no longer needed and is owned here.
            unsafe { CM_Free_Res_Des_Handle(old) };
        }
        // SAFETY: logical configuration handle is owned by this function.
        unsafe { CM_Free_Log_Conf_Handle(logical_configuration) };
        if status != CR_NO_MORE_RES_DES {
            return Err(BackendError::DeviceInventory(format!(
                "CM_Get_Next_Res_Des failed with CONFIGRET {status}"
            )));
        }
        Ok(resources)
    }

    fn process_memory_range(
        resources: &mut MemoryResources,
        first_resource: &mut bool,
        base: u64,
        top: u64,
        flags: u32,
    ) {
        if flags & mMD_MemoryType == fMD_RAM && flags & mMD_Readable == fMD_ReadAllowed {
            let size = top.saturating_sub(base).saturating_add(1);
            resources.max_size = resources.max_size.max(size);
            if *first_resource {
                resources.bar0_base = base;
                resources.bar0_top = top;
                *first_resource = false;
            }
        } else if *first_resource {
            *first_resource = false;
        }
    }

    struct AdapterMemory {
        vendor_id: u16,
        device_id: u16,
        subsystem_id: u32,
        dedicated_video_memory: u64,
    }

    fn dedicated_memory_by_adapter() -> BackendResult<Vec<AdapterMemory>> {
        // SAFETY: COM is managed by windows-rs interface wrappers.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
            .map_err(|error| BackendError::DeviceInventory(error.to_string()))?;
        let mut result = Vec::new();
        for index in 0.. {
            // SAFETY: index is bounded by the factory; failure terminates enumeration.
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
                break;
            };
            // SAFETY: adapter interface is valid.
            let description = unsafe { adapter.GetDesc1() }
                .map_err(|error| BackendError::DeviceInventory(error.to_string()))?;
            result.push(AdapterMemory {
                vendor_id: description.VendorId as u16,
                device_id: description.DeviceId as u16,
                subsystem_id: description.SubSysId,
                dedicated_video_memory: description.DedicatedVideoMemory as u64,
            });
        }
        Ok(result)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_pci_instance_identifiers() {
            let ids =
                parse_pci_ids("PCI\\VEN_10DE&DEV_1E84&SUBSYS_37221462&REV_A1").expect("parse");
            assert_eq!(ids.vendor_id, 0x10DE);
            assert_eq!(ids.device_id, 0x1E84);
            assert_eq!(ids.subsystem_device_id, 0x3722);
            assert_eq!(ids.subsystem_vendor_id, 0x1462);
        }

        #[test]
        fn inventory_api_returns_only_nvidia_adapters() {
            let devices = enumerate_gpus().expect("read-only GPU inventory should succeed");
            assert!(
                devices
                    .iter()
                    .all(|device| device.vendor_id == NVIDIA_VENDOR_ID)
            );
        }
    }
}
