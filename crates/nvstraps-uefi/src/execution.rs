use nvstraps_core::pci::PciAddress;
use nvstraps_core::status::EfiErrorLocation;

/// Everything required to temporarily expose one GPU's BAR0 and update its
/// BAR1 straps. The transaction Module owns the dangerous operation order;
/// adapters only perform the individual firmware or simulated operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceTransaction {
    pub device: PciAddress,
    pub bridge: PciAddress,
    pub bar0_base: u64,
    pub bar0_top: u64,
    pub bridge_io_base_limit: u64,
    pub bar_size_selector: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionFault {
    InvalidConfiguration,
    Firmware {
        location: EfiErrorLocation,
        status: u8,
        address: Option<PciAddress>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrapProgramReceipt {
    pub reported_changed: bool,
    pub resume_fault: Option<ExecutionFault>,
}

/// Narrow Seam between the transaction policy and an execution environment.
/// Implementations may use real UEFI protocols or an in-memory simulation.
pub trait FirmwareExecutionAdapter {
    type BridgeState;
    type DeviceState;

    fn remap_bridge(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<Self::BridgeState, ExecutionFault>;

    fn remap_device_bar0(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<Self::DeviceState, ExecutionFault>;

    fn program_bar1_straps(
        &mut self,
        request: &DeviceTransaction,
    ) -> Result<StrapProgramReceipt, ExecutionFault>;

    fn restore_device_bar0(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::DeviceState,
    ) -> Result<(), ExecutionFault>;

    fn restore_bridge(
        &mut self,
        request: &DeviceTransaction,
        saved: Self::BridgeState,
    ) -> Result<(), ExecutionFault>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceTransactionReceipt {
    BridgeRemapFailed {
        failure: ExecutionFault,
    },
    DeviceRemapFailed {
        failure: ExecutionFault,
        bridge_restore_failure: Option<ExecutionFault>,
    },
    RestorationFailed {
        device_failure: Option<ExecutionFault>,
        bridge_failure: Option<ExecutionFault>,
    },
    StrapProgrammingFailed {
        failure: ExecutionFault,
    },
    Completed(StrapProgramReceipt),
}

/// Executes a single GPU transaction and guarantees that every acquired
/// remap is offered its matching restore, in reverse acquisition order.
pub fn execute_device_transaction(
    adapter: &mut impl FirmwareExecutionAdapter,
    request: &DeviceTransaction,
) -> DeviceTransactionReceipt {
    let bridge = match adapter.remap_bridge(request) {
        Ok(saved) => saved,
        Err(failure) => return DeviceTransactionReceipt::BridgeRemapFailed { failure },
    };
    let device = match adapter.remap_device_bar0(request) {
        Ok(saved) => saved,
        Err(failure) => {
            let bridge_restore_failure = adapter.restore_bridge(request, bridge).err();
            return DeviceTransactionReceipt::DeviceRemapFailed {
                failure,
                bridge_restore_failure,
            };
        }
    };

    let strap = adapter.program_bar1_straps(request);
    let device_failure = adapter.restore_device_bar0(request, device).err();
    let bridge_failure = adapter.restore_bridge(request, bridge).err();
    if device_failure.is_some() || bridge_failure.is_some() {
        return DeviceTransactionReceipt::RestorationFailed {
            device_failure,
            bridge_failure,
        };
    }

    match strap {
        Ok(receipt) => DeviceTransactionReceipt::Completed(receipt),
        Err(failure) => DeviceTransactionReceipt::StrapProgrammingFailed { failure },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulation::{ExecutionAction, SimulationAdapter};

    const DEVICE: PciAddress = PciAddress {
        bus: 1,
        device: 0,
        function: 0,
    };
    const BRIDGE: PciAddress = PciAddress {
        bus: 0,
        device: 1,
        function: 0,
    };
    const REQUEST: DeviceTransaction = DeviceTransaction {
        device: DEVICE,
        bridge: BRIDGE,
        bar0_base: 0xc000_0000,
        bar0_top: 0xc0ff_ffff,
        bridge_io_base_limit: 0xf1f1,
        bar_size_selector: 5,
    };

    fn fault(location: EfiErrorLocation, status: u8) -> ExecutionFault {
        ExecutionFault::Firmware {
            location,
            status,
            address: Some(DEVICE),
        }
    }

    #[test]
    fn successful_transaction_restores_in_reverse_order() {
        let mut adapter = SimulationAdapter::default();

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::Completed(StrapProgramReceipt {
                reported_changed: true,
                resume_fault: None,
            })
        );
        assert_eq!(
            adapter.actions(),
            &[
                ExecutionAction::RemapBridge,
                ExecutionAction::RemapDeviceBar0,
                ExecutionAction::ProgramBar1Straps,
                ExecutionAction::RestoreDeviceBar0,
                ExecutionAction::RestoreBridge,
            ]
        );
    }

    #[test]
    fn bridge_remap_failure_performs_no_later_operation() {
        let primary = ExecutionFault::InvalidConfiguration;
        let mut adapter = SimulationAdapter::default().fail(ExecutionAction::RemapBridge, primary);

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::BridgeRemapFailed { failure: primary }
        );
        assert_eq!(adapter.actions(), &[ExecutionAction::RemapBridge]);
    }

    #[test]
    fn device_remap_failure_still_restores_the_bridge() {
        let primary = fault(EfiErrorLocation::PciDeviceBarConfig, 7);
        let restore = fault(EfiErrorLocation::PciBridgeRestore, 9);
        let mut adapter = SimulationAdapter::default()
            .fail(ExecutionAction::RemapDeviceBar0, primary)
            .fail(ExecutionAction::RestoreBridge, restore);

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::DeviceRemapFailed {
                failure: primary,
                bridge_restore_failure: Some(restore),
            }
        );
        assert_eq!(
            adapter.actions(),
            &[
                ExecutionAction::RemapBridge,
                ExecutionAction::RemapDeviceBar0,
                ExecutionAction::RestoreBridge,
            ]
        );
    }

    #[test]
    fn strap_failure_is_reported_only_after_both_restores() {
        let primary = ExecutionFault::InvalidConfiguration;
        let mut adapter =
            SimulationAdapter::default().fail(ExecutionAction::ProgramBar1Straps, primary);

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::StrapProgrammingFailed { failure: primary }
        );
        assert_eq!(
            adapter.actions(),
            &[
                ExecutionAction::RemapBridge,
                ExecutionAction::RemapDeviceBar0,
                ExecutionAction::ProgramBar1Straps,
                ExecutionAction::RestoreDeviceBar0,
                ExecutionAction::RestoreBridge,
            ]
        );
    }

    #[test]
    fn every_restore_is_attempted_and_both_failures_are_preserved() {
        let device = fault(EfiErrorLocation::PciDeviceBarRestore, 3);
        let bridge = fault(EfiErrorLocation::PciBridgeRestore, 4);
        let mut adapter = SimulationAdapter::default()
            .fail(ExecutionAction::RestoreDeviceBar0, device)
            .fail(ExecutionAction::RestoreBridge, bridge);

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::RestorationFailed {
                device_failure: Some(device),
                bridge_failure: Some(bridge),
            }
        );
        assert_eq!(
            adapter.actions().last(),
            Some(&ExecutionAction::RestoreBridge)
        );
    }

    #[test]
    fn resume_recording_fault_survives_a_successful_restore() {
        let resume = fault(EfiErrorLocation::WriteS3SaveStateProtocol, 11);
        let mut adapter = SimulationAdapter::default().with_resume_fault(resume);

        let receipt = execute_device_transaction(&mut adapter, &REQUEST);

        assert_eq!(
            receipt,
            DeviceTransactionReceipt::Completed(StrapProgramReceipt {
                reported_changed: true,
                resume_fault: Some(resume),
            })
        );
    }
}
