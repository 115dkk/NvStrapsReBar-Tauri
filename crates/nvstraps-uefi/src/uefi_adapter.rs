use nvstraps_core::pci::{BridgeSavedConfig, DeviceSavedConfig};
use nvstraps_core::status::EfiErrorLocation;

use crate::execution::{
    DeviceTransaction, ExecutionFault, FirmwareExecutionAdapter, StrapProgramReceipt,
};
use crate::mmio::MappedBar0;
use crate::pci::{MappingFailure, PciAccess, PciFailure};
use crate::s3::S3Script;
use crate::straps::configure_bar1_size;

pub struct UefiExecutionAdapter<'operation, 'root> {
    pci: &'operation mut PciAccess<'root>,
    resume: &'operation mut S3Script,
    mapped_bar0: Option<MappedBar0>,
}

impl<'operation, 'root> UefiExecutionAdapter<'operation, 'root> {
    pub const fn new(
        pci: &'operation mut PciAccess<'root>,
        resume: &'operation mut S3Script,
    ) -> Self {
        Self {
            pci,
            resume,
            mapped_bar0: None,
        }
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
                request.bridge(),
                request.bar0(),
                request.bridge_io_base_limit(),
                self.resume,
            )
            .map_err(mapping_fault)
    }

    fn remap_device_bar0(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<Self::DeviceState, ExecutionFault> {
        if self.mapped_bar0.is_some() {
            return Err(ExecutionFault::InvalidConfiguration);
        }
        let (saved, mapped) = self
            .pci
            .save_and_remap_device_bar0(request.device(), request.bar0(), self.resume)
            .map_err(mapping_fault)?;
        self.mapped_bar0 = Some(mapped);
        Ok(saved)
    }

    fn program_bar1_straps(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<StrapProgramReceipt, ExecutionFault> {
        let mapped = self
            .mapped_bar0
            .as_mut()
            .ok_or(ExecutionFault::InvalidConfiguration)?;
        let result = configure_bar1_size(mapped, request.bar_size_selector(), self.resume)
            .map_err(|_| ExecutionFault::InvalidConfiguration)?;
        Ok(StrapProgramReceipt {
            reported_changed: result.reported_changed,
            resume_fault: result.resume_error.map(|status| ExecutionFault::Firmware {
                location: EfiErrorLocation::WriteS3SaveStateProtocol,
                status: status_code(status),
                address: Some(request.device()),
            }),
        })
    }

    fn restore_device_bar0(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::DeviceState,
    ) -> Result<(), ExecutionFault> {
        if self.mapped_bar0.take().is_none() {
            return Err(ExecutionFault::InvalidConfiguration);
        }
        self.pci
            .restore_device_bar0(request.device(), saved)
            .map_err(pci_fault)
    }

    fn restore_bridge(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::BridgeState,
    ) -> Result<(), ExecutionFault> {
        self.pci
            .restore_bridge(request.bridge(), saved)
            .map_err(pci_fault)
    }
}

fn mapping_fault(failure: MappingFailure) -> ExecutionFault {
    match failure {
        MappingFailure::InvalidConfiguration(_) | MappingFailure::InvalidMmio(_) => {
            ExecutionFault::InvalidConfiguration
        }
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
