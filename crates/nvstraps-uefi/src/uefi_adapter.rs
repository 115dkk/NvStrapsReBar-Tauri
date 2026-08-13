use nvstraps_core::pci::{BridgeSavedConfig, DeviceSavedConfig};
use nvstraps_core::status::EfiErrorLocation;

use crate::execution::{
    DeviceTransaction, ExecutionFault, FirmwareExecutionAdapter, StrapProgramReceipt,
};
use crate::pci::{MappingFailure, PciAccess, PciFailure};
use crate::s3::S3Script;
use crate::straps::configure_bar1_size;

pub struct UefiExecutionAdapter<'operation, 'root> {
    pci: &'operation mut PciAccess<'root>,
    resume: &'operation mut S3Script,
}

impl<'operation, 'root> UefiExecutionAdapter<'operation, 'root> {
    pub const fn new(
        pci: &'operation mut PciAccess<'root>,
        resume: &'operation mut S3Script,
    ) -> Self {
        Self { pci, resume }
    }
}

impl FirmwareExecutionAdapter for UefiExecutionAdapter<'_, '_> {
    type BridgeState = BridgeSavedConfig;
    type DeviceState = DeviceSavedConfig;

    fn remap_bridge(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<Self::BridgeState, ExecutionFault> {
        self.pci
            .save_and_remap_bridge(
                request.bridge,
                request.bar0_base,
                request.bar0_top,
                request.bridge_io_base_limit,
                self.resume,
            )
            .map_err(mapping_fault)
    }

    fn remap_device_bar0(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<Self::DeviceState, ExecutionFault> {
        self.pci
            .save_and_remap_device_bar0(request.device, request.bar0_base, self.resume)
            .map_err(mapping_fault)
    }

    fn program_bar1_straps(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<StrapProgramReceipt, ExecutionFault> {
        // SAFETY: The transaction Module invokes this only after the bridge
        // and BAR0 adapters have successfully exposed the validated range.
        let result = unsafe {
            configure_bar1_size(
                request.bar0_base & !0x0f,
                request.bar_size_selector,
                self.resume,
            )
        }
        .map_err(|_| ExecutionFault::InvalidConfiguration)?;
        Ok(StrapProgramReceipt {
            reported_changed: result.reported_changed,
            resume_fault: result.resume_error.map(|status| ExecutionFault::Firmware {
                location: EfiErrorLocation::WriteS3SaveStateProtocol,
                status: status_code(status),
                address: Some(request.device),
            }),
        })
    }

    fn restore_device_bar0(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::DeviceState,
    ) -> Result<(), ExecutionFault> {
        self.pci
            .restore_device_bar0(request.device, saved)
            .map_err(pci_fault)
    }

    fn restore_bridge(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::BridgeState,
    ) -> Result<(), ExecutionFault> {
        self.pci
            .restore_bridge(request.bridge, saved)
            .map_err(pci_fault)
    }
}

fn mapping_fault(failure: MappingFailure) -> ExecutionFault {
    match failure {
        MappingFailure::InvalidConfiguration(_) => ExecutionFault::InvalidConfiguration,
        MappingFailure::Firmware(failure) => pci_fault(failure),
    }
}

fn pci_fault(failure: PciFailure) -> ExecutionFault {
    ExecutionFault::Firmware {
        location: failure.location,
        status: status_code(failure.status),
        address: failure.address,
    }
}

const fn status_code(status: uefi::Status) -> u8 {
    (status.0 & 0xff) as u8
}
