use core::time::Duration;

use nvstraps_core::boot_policy::{
    EffectiveTarget, apply_known_rebar_mask_quirk, select_global_rebar_size,
};
use nvstraps_core::config::{Config, ConfigPriority, DeviceIdentity, MAX_BRIDGE_COUNT};
use nvstraps_core::pci::{
    PciAddress, RESIZABLE_BAR_CAPABILITY_ID, is_pci_bridge, is_vga_controller,
};
use nvstraps_core::registry::{
    BAR_SIZE_EXCLUDED, BAR_SIZE_NONE, MAX_BAR_SIZE_SELECTOR, NVIDIA_VENDOR_ID, is_turing,
};
use nvstraps_core::status::{EfiErrorLocation, StatusCode};
use nvstraps_core::straps::{
    BAR1_INDEX, add_bar1_size_to_mask, bar1_rebar_size_bit, bar1_size_is_advertised,
    validate_gpu_window,
};
use uefi::{Handle, Status, boot};

use crate::pci::{MappingFailure, PciAccess, PciFailure, open_root_bridge};
use crate::s3::S3Script;
use crate::status_writer::StatusWriter;
use crate::straps::configure_bar1_size;

const TARGET_BRIDGE_IO_BASE_LIMIT: u64 = 0xf1f1;
const PCI_BAR_COUNT: u8 = 6;

pub struct FirmwareEngine {
    config: Config,
    target: EffectiveTarget,
    resume: S3Script,
    status: StatusWriter,
    enumerated_bridges: [Option<PciAddress>; MAX_BRIDGE_COUNT],
}

impl FirmwareEngine {
    pub const fn new(
        config: Config,
        target: EffectiveTarget,
        resume: S3Script,
        status: StatusWriter,
    ) -> Self {
        Self {
            config,
            target,
            resume,
            status,
            enumerated_bridges: [None; MAX_BRIDGE_COUNT],
        }
    }

    pub fn process_device(&mut self, root_bridge: Handle, address: PciAddress) {
        let mut root = match open_root_bridge(root_bridge) {
            Ok(root) => root,
            Err(status) => {
                self.record_efi_error(EfiErrorLocation::LoadBridgeProtocol, status, Some(address));
                return;
            }
        };
        let mut pci = PciAccess::new(&mut root);
        let header = match pci.device_header(address) {
            Ok(Some(header)) => header,
            Ok(None) => return,
            Err(status) => {
                self.record_efi_error(EfiErrorLocation::PciDeviceSubsystem, status, Some(address));
                return;
            }
        };

        self.remember_configured_bridge(header.address, header.header_type);
        let selected = self.identify_selected_gpu(
            &mut pci,
            header.address,
            header.vendor_id,
            header.device_id,
        );
        if let Some(identity) = selected {
            self.setup_selected_gpu(&mut pci, identity);
        }
        if let EffectiveTarget::Global(maximum) = self.target {
            self.resize_device_bars(
                &mut pci,
                header.address,
                header.vendor_id,
                header.device_id,
                selected,
                maximum,
            );
        }
    }

    pub const fn config(&self) -> &Config {
        &self.config
    }

    pub const fn status(&self) -> &StatusWriter {
        &self.status
    }

    fn remember_configured_bridge(&mut self, address: PciAddress, header_type: u8) {
        if !is_pci_bridge(header_type)
            || self
                .config
                .bridge_device(address.bus, address.device, address.function)
                .is_none()
            || self.bridge_was_enumerated(address)
        {
            return;
        }
        if let Some(slot) = self
            .enumerated_bridges
            .iter_mut()
            .find(|slot| slot.is_none())
        {
            *slot = Some(address);
            self.record_status(StatusCode::BridgeFound, None);
        }
    }

    fn identify_selected_gpu(
        &mut self,
        pci: &mut PciAccess<'_>,
        address: PciAddress,
        vendor_id: u16,
        device_id: u16,
    ) -> Option<DeviceIdentity> {
        if vendor_id != NVIDIA_VENDOR_ID || !self.config.is_gpu_configured() {
            return None;
        }
        match pci.device_class(address) {
            Ok(class) if is_vga_controller(class) => {}
            Ok(_) => return None,
            Err(status) => {
                self.record_efi_error(EfiErrorLocation::PciDeviceSubsystem, status, Some(address));
                return None;
            }
        }
        let (subsystem_vendor_id, subsystem_device_id) = match pci.device_subsystem(address) {
            Ok(subsystem) => subsystem,
            Err(status) => {
                self.record_efi_error(EfiErrorLocation::PciDeviceSubsystem, status, Some(address));
                return None;
            }
        };
        let identity = DeviceIdentity {
            device_id,
            subsystem_vendor_id,
            subsystem_device_id,
            bus: address.bus,
            device: address.device,
            function: address.function,
        };
        let decision = self.config.lookup_bar_size(identity);
        if decision.priority == ConfigPriority::Unconfigured
            || matches!(decision.selector, None | Some(BAR_SIZE_NONE))
        {
            self.record_status(StatusCode::GpuUnconfigured, Some(address));
            return None;
        }
        if decision.selector == Some(BAR_SIZE_EXCLUDED) {
            self.record_status(StatusCode::GpuExcluded, Some(address));
            return None;
        }
        if decision
            .selector
            .is_some_and(|selector| selector > MAX_BAR_SIZE_SELECTOR)
        {
            self.record_status(StatusCode::BadGpuConfig, Some(address));
            return None;
        }
        self.record_status(StatusCode::GpuFound, Some(address));
        Some(identity)
    }

    fn setup_selected_gpu(&mut self, pci: &mut PciAccess<'_>, identity: DeviceIdentity) {
        let address = identity_address(identity);
        let decision = self.config.lookup_bar_size(identity);
        let Some(selector) = decision.selector else {
            return;
        };
        let Some(gpu_config) = self
            .config
            .lookup_gpu_config(address.bus, address.device, address.function)
            .cloned()
        else {
            self.record_status(StatusCode::NoGpuConfig, Some(address));
            return;
        };
        if validate_gpu_window(&gpu_config).is_err() {
            self.record_status(StatusCode::BadGpuConfig, Some(address));
            return;
        }
        let Some(bridge_config) = self.config.lookup_bridge_config(address.bus).cloned() else {
            self.record_status(StatusCode::NoBridgeConfig, Some(address));
            return;
        };
        let Some(bridge_address) = PciAddress::new(
            bridge_config.bus,
            bridge_config.device,
            bridge_config.function,
        ) else {
            self.record_status(StatusCode::BadBridgeConfig, Some(address));
            return;
        };
        if !self.bridge_was_enumerated(bridge_address) {
            self.record_status(StatusCode::BridgeNotEnumerated, Some(address));
            return;
        }
        match pci.bridge_secondary_bus(bridge_address) {
            Ok(secondary_bus) if secondary_bus == address.bus => {}
            Ok(_) => {
                self.record_status(StatusCode::BadBridgeConfig, Some(address));
                return;
            }
            Err(status) => {
                self.record_efi_error(
                    EfiErrorLocation::PciBridgeSecondaryBus,
                    status,
                    Some(address),
                );
                return;
            }
        }

        let bridge_saved = match pci.save_and_remap_bridge(
            bridge_address,
            gpu_config.bar0_base,
            gpu_config.bar0_top,
            TARGET_BRIDGE_IO_BASE_LIMIT,
            &mut self.resume,
        ) {
            Ok(saved) => saved,
            Err(failure) => {
                self.record_mapping_failure(failure, address, StatusCode::BadBridgeConfig);
                return;
            }
        };
        let device_saved =
            match pci.save_and_remap_device_bar0(address, gpu_config.bar0_base, &mut self.resume) {
                Ok(saved) => saved,
                Err(failure) => {
                    self.record_mapping_failure(failure, address, StatusCode::BadGpuConfig);
                    if let Err(failure) = pci.restore_bridge(bridge_address, bridge_saved) {
                        self.record_pci_failure(failure);
                    }
                    return;
                }
            };

        // SAFETY: Both the bridge window and BAR0 were validated and remapped
        // to the configured 32-bit MMIO range for the duration of this call.
        let strap_result = unsafe {
            configure_bar1_size(gpu_config.bar0_base & !0x0f, selector, &mut self.resume)
        };
        let device_restore = pci.restore_device_bar0(address, device_saved);
        let bridge_restore = pci.restore_bridge(bridge_address, bridge_saved);
        let mut restore_failed = false;
        if let Err(failure) = device_restore {
            self.record_pci_failure(failure);
            restore_failed = true;
        }
        if let Err(failure) = bridge_restore {
            self.record_pci_failure(failure);
            restore_failed = true;
        }
        if restore_failed {
            return;
        }
        let strap_result = match strap_result {
            Ok(result) => result,
            Err(_) => {
                self.record_status(StatusCode::BadGpuConfig, Some(address));
                return;
            }
        };
        if let Some(status) = strap_result.resume_error {
            self.record_efi_error(
                EfiErrorLocation::WriteS3SaveStateProtocol,
                status,
                Some(address),
            );
        }
        self.record_status(
            if strap_result.reported_changed {
                StatusCode::GpuStrapsConfigured
            } else {
                StatusCode::GpuStrapsPreConfigured
            },
            Some(address),
        );

        let capability = match pci.find_extended_capability(address, RESIZABLE_BAR_CAPABILITY_ID) {
            Ok(capability) => capability,
            Err(failure) => {
                self.record_pci_failure(failure);
                None
            }
        };
        let mask = match capability {
            Some(capability) => match pci.rebar_possible_sizes(address, capability, BAR1_INDEX) {
                Ok(mask) => mask,
                Err(status) => {
                    self.record_efi_error(
                        EfiErrorLocation::PciFindCapability,
                        status,
                        Some(address),
                    );
                    0
                }
            },
            None => 0,
        };
        if mask != 0 {
            self.record_status(
                if bar1_size_is_advertised(mask, selector) {
                    StatusCode::GpuStrapsConfirm
                } else {
                    StatusCode::GpuStrapsNoConfirm
                },
                Some(address),
            );
        } else if is_turing(identity.device_id) {
            self.record_status(StatusCode::GpuNoReBarCapability, Some(address));
        }

        match self.target {
            EffectiveTarget::SelectedGpuOnly => {
                let override_mask = self.config.lookup_bar_size_mask_override(identity).enabled;
                if let (Some(capability), Some(size_bit)) =
                    (capability, bar1_rebar_size_bit(selector))
                    && (bar1_size_is_advertised(mask, selector) || override_mask)
                {
                    if !bar1_size_is_advertised(mask, selector) {
                        self.record_status(StatusCode::GpuReBarSizeOverride, Some(address));
                    }
                    match pci.set_rebar_size(address, capability, BAR1_INDEX, size_bit) {
                        Ok(true) => {
                            self.record_status(StatusCode::GpuReBarConfigured, Some(address));
                        }
                        Ok(false) => {}
                        Err(status) => self.record_efi_error(
                            EfiErrorLocation::PciFindCapability,
                            status,
                            Some(address),
                        ),
                    }
                }
            }
            EffectiveTarget::StrapsOnly => boot::stall(Duration::from_millis(100)),
            EffectiveTarget::Disabled | EffectiveTarget::Global(_) => {}
        }
    }

    fn resize_device_bars(
        &mut self,
        pci: &mut PciAccess<'_>,
        address: PciAddress,
        vendor_id: u16,
        device_id: u16,
        selected: Option<DeviceIdentity>,
        maximum: u8,
    ) {
        let capability = match pci.find_extended_capability(address, RESIZABLE_BAR_CAPABILITY_ID) {
            Ok(Some(capability)) => capability,
            Ok(None) => return,
            Err(failure) => {
                self.record_pci_failure(failure);
                return;
            }
        };
        for bar_index in 0..PCI_BAR_COUNT {
            let mut mask = match pci.rebar_possible_sizes(address, capability, bar_index) {
                Ok(mask) => apply_known_rebar_mask_quirk(vendor_id, device_id, bar_index, mask),
                Err(status) => {
                    self.record_efi_error(
                        EfiErrorLocation::PciFindCapability,
                        status,
                        Some(address),
                    );
                    continue;
                }
            };
            if let Some(identity) = selected
                && bar_index == BAR1_INDEX
                && self.should_override_bar1_mask(identity)
                && let Some((adjusted, changed)) = add_bar1_size_to_mask(
                    mask,
                    self.config
                        .lookup_bar_size(identity)
                        .selector
                        .unwrap_or(BAR_SIZE_NONE),
                )
            {
                mask = adjusted;
                if changed {
                    self.record_status(StatusCode::GpuReBarSizeOverride, Some(address));
                }
            }
            let Some(size_bit) = select_global_rebar_size(mask, maximum) else {
                continue;
            };
            match pci.set_rebar_size(address, capability, bar_index, size_bit) {
                Ok(true) if selected.is_some() => {
                    self.record_status(StatusCode::GpuReBarConfigured, Some(address));
                }
                Ok(_) => {}
                Err(status) => self.record_efi_error(
                    EfiErrorLocation::PciFindCapability,
                    status,
                    Some(address),
                ),
            }
        }
    }

    fn should_override_bar1_mask(&self, identity: DeviceIdentity) -> bool {
        if !self.config.lookup_bar_size_mask_override(identity).enabled {
            return false;
        }
        self.config
            .lookup_bridge_config(identity.bus)
            .and_then(|bridge| PciAddress::new(bridge.bus, bridge.device, bridge.function))
            .is_some_and(|bridge| self.bridge_was_enumerated(bridge))
    }

    fn bridge_was_enumerated(&self, address: PciAddress) -> bool {
        self.enumerated_bridges.contains(&Some(address))
    }

    fn record_mapping_failure(
        &mut self,
        failure: MappingFailure,
        device: PciAddress,
        invalid_status: StatusCode,
    ) {
        match failure {
            MappingFailure::InvalidConfiguration(_) => {
                self.record_status(invalid_status, Some(device));
            }
            MappingFailure::Firmware(failure) => self.record_pci_failure(failure),
        }
    }

    fn record_pci_failure(&mut self, failure: PciFailure) {
        self.record_efi_error(failure.location, failure.status, failure.address);
    }

    fn record_status(&mut self, code: StatusCode, address: Option<PciAddress>) {
        let _ = self.status.record(code, address.map(PciAddress::location));
    }

    fn record_efi_error(
        &mut self,
        location: EfiErrorLocation,
        status: Status,
        address: Option<PciAddress>,
    ) {
        let _ = self
            .status
            .record_efi_error(location, status, address.map(PciAddress::location));
    }
}

const fn identity_address(identity: DeviceIdentity) -> PciAddress {
    PciAddress {
        bus: identity.bus,
        device: identity.device,
        function: identity.function,
    }
}
